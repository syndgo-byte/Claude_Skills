'use strict';
// Builds skill/plugin recommendations from installed marketplaces and GitHub.
const https = require('https');

// File extension or file name -> keywords that plugin descriptions tend to use.
const PROFILE_RULES = [
  [/\.py$/i, ['python', 'pyright', 'django', 'flask', 'fastapi', 'pytest']],
  [/\.ipynb$/i, ['jupyter', 'notebook', 'data', 'pandas']],
  [/\.(js|mjs|cjs|jsx)$/i, ['javascript', 'node', 'frontend', 'react']],
  [/\.(ts|tsx)$/i, ['typescript', 'frontend', 'react']],
  [/\.(html|css|scss|vue|svelte)$/i, ['frontend', 'ui', 'design', 'css', 'playwright', 'browser']],
  [/\.(sql|db|sqlite)$/i, ['database', 'sql', 'postgres', 'sqlite']],
  [/\.(go)$/i, ['go', 'golang', 'gopls']],
  [/\.(rs)$/i, ['rust', 'rust-analyzer']],
  [/\.(java|kt)$/i, ['java', 'kotlin']],
  [/\.(cs)$/i, ['csharp', 'dotnet']],
  [/\.(dxf|dwg)$/i, ['cad', 'drawing']],
  [/\.(xlsx|csv)$/i, ['excel', 'spreadsheet', 'csv', 'data']],
  [/(^|[\\/])Dockerfile$/i, ['docker', 'container', 'deploy']],
  [/\.(ya?ml)$/i, ['ci', 'github', 'deploy']],
];
const ALWAYS = ['workflow', 'review', 'test', 'debug', 'git', 'commit'];

function buildProfile(fileNames) {
  const counts = new Map();
  for (const name of fileNames) {
    for (const [re, words] of PROFILE_RULES) {
      if (!re.test(name)) continue;
      for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  const weights = new Map(ALWAYS.map((w) => [w, 1]));
  const max = Math.max(1, ...counts.values());
  for (const [w, c] of counts) weights.set(w, (weights.get(w) || 0) + 1 + Math.round((4 * c) / max));
  return weights;
}

function matchScore(text, profile) {
  const hay = (text || '').toLowerCase();
  const matched = [];
  let score = 0;
  for (const [word, weight] of profile) {
    if (new RegExp(`\\b${word.replace(/[-]/g, '\\-')}\\b`).test(hay)) {
      score += weight;
      matched.push(word);
    }
  }
  return { score, matched };
}

// Plugins listed in added marketplaces that are not installed yet.
function fromMarketplaces(markets, installedIds, profile) {
  const list = [];
  for (const market of markets) {
    for (const p of market.plugins) {
      const id = `${p.name}@${market.name}`;
      if (installedIds.has(id)) continue;
      const text = [p.name, p.description, p.category, ...(p.keywords || []), ...(p.tags || [])].join(' ');
      const { score, matched } = matchScore(text, profile);
      if (score <= 1) continue;
      const official = market.name === 'claude-plugins-official';
      list.push({
        kind: 'market', id, name: p.name, marketplace: market.name,
        description: p.description || '', category: p.category,
        matched, score: score + (official ? 2 : 0),
      });
    }
  }
  return list.sort((a, b) => b.score - a.score);
}

function getJson(url, token) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'claude-plugin-manager', Accept: 'application/vnd.github+json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    https.get(url, { headers, timeout: 20000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 403 || res.statusCode === 429) {
          reject(new Error('GitHub API 호출 한도를 넘었습니다. 설정에 githubToken을 넣으면 한도가 늘어납니다.'));
        } else if (res.statusCode >= 400) {
          reject(new Error(`GitHub ${res.statusCode}: ${body.slice(0, 200)}`));
        } else {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('GitHub 요청 시간 초과')); });
  });
}

// HEAD request against raw content: tells whether the repo is a plugin marketplace.
function hasFile(repo, file) {
  return new Promise((resolve) => {
    const req = https.request(`https://raw.githubusercontent.com/${repo}/HEAD/${file}`,
      { method: 'HEAD', headers: { 'User-Agent': 'claude-plugin-manager' }, timeout: 10000 },
      (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

async function fromGitHub(token, profile, knownRepos) {
  const recent = isoDaysAgo(90);
  const fresh = isoDaysAgo(60);
  const queries = [
    { q: `topic:claude-code-plugin pushed:>${recent}`, tag: 'hot' },
    { q: `topic:claude-skills pushed:>${recent}`, tag: 'hot' },
    { q: `topic:claude-code-skills pushed:>${recent}`, tag: 'hot' },
    { q: `topic:agent-skills pushed:>${recent}`, tag: 'hot' },
    { q: `claude code plugin in:name,description pushed:>${recent} stars:>200`, tag: 'hot' },
    { q: `claude skills in:name,description,topics created:>${fresh} stars:>50`, tag: 'rising' },
  ];
  const repos = new Map();
  const errors = [];
  for (const { q, tag } of queries) {
    try {
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=30`;
      const data = await getJson(url, token);
      for (const r of data.items || []) {
        const prev = repos.get(r.full_name);
        if (prev) { if (tag === 'rising') prev.rising = true; continue; }
        repos.set(r.full_name, { repo: r, rising: tag === 'rising' });
      }
    } catch (e) {
      errors.push(e.message);
      if (/한도/.test(e.message)) break;
    }
  }

  const now = Date.now();
  const list = [...repos.values()]
    .filter(({ repo }) => !repo.archived && !repo.fork)
    .map(({ repo, rising }) => {
      const stars = repo.stargazers_count;
      const ageDays = Math.max(1, (now - Date.parse(repo.created_at)) / 86400000);
      const pushedDays = (now - Date.parse(repo.pushed_at)) / 86400000;
      const velocity = stars / ageDays;
      const text = [repo.name, repo.description, ...(repo.topics || [])].join(' ');
      const { score: fit, matched } = matchScore(text, profile);
      const hot = Math.log10(stars + 1) * 10 + Math.min(20, velocity * 2) + (pushedDays < 14 ? 5 : 0) + Math.min(10, fit);
      return {
        kind: 'github', id: repo.full_name, name: repo.name, repo: repo.full_name,
        description: repo.description || '', url: repo.html_url,
        stars, velocity, ageDays: Math.round(ageDays), pushedDays: Math.round(pushedDays),
        topics: repo.topics || [], matched, score: hot,
        rising: rising || (ageDays < 60 && stars > 50),
        known: knownRepos.has(repo.full_name.toLowerCase()),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 40);

  // Check which repos can be added with `claude plugin marketplace add`.
  await Promise.all(list.map(async (item) => {
    item.installable = await hasFile(item.repo, '.claude-plugin/marketplace.json');
  }));

  return { list, errors };
}

module.exports = { buildProfile, fromMarketplaces, fromGitHub };
