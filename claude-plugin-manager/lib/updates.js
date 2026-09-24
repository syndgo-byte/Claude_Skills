'use strict';
// Detects installed plugins whose GitHub source has new commits.
const { execFile } = require('child_process');
const https = require('https');
const path = require('path');
const store = require('./store');

function gitHead(repo, env) {
  return new Promise((resolve, reject) => {
    execFile('git', ['ls-remote', `https://github.com/${repo}.git`, 'HEAD'], { env, timeout: 30000, windowsHide: true },
      (err, stdout) => {
        const sha = (stdout || '').trim().split(/\s+/)[0];
        if (err || !/^[0-9a-f]{40}$/.test(sha)) reject(new Error(`${repo}: 원격 저장소 확인 실패`));
        else resolve(sha);
      });
  });
}

function getJson(url, token) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'claude-plugin-manager', Accept: 'application/vnd.github+json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    https.get(url, { headers, timeout: 20000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 403 || res.statusCode === 429) reject(new Error('GitHub API 호출 한도 초과'));
        else if (res.statusCode >= 400) reject(new Error(`GitHub ${res.statusCode}`));
        else { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('GitHub 요청 시간 초과')); });
  });
}

function repoFromUrl(url) {
  const m = (url || '').match(/github\.com[/:]([^/\s]+\/[^/\s#?]+?)(\.git)?(?:[/#?]|$)/i);
  return m ? m[1] : null;
}

// Where a plugin's files live on GitHub: { repo, dir } (dir '' = whole repo).
function sourceOf(plugin, knownMarkets, markets) {
  const km = knownMarkets[plugin.marketplace];
  const marketRepo = km && km.source && (km.source.repo || repoFromUrl(km.source.url));
  const market = markets.find((m) => m.name === plugin.marketplace);
  const entry = market && market.plugins.find((p) => p.name === plugin.name);
  const src = entry && entry.source;
  if (typeof src === 'string') {
    if (!marketRepo) return null;
    const dir = path.posix.normalize(src.replace(/\\/g, '/')).replace(/^\.\/?|\/$/g, '').replace(/^\.$/, '');
    return { repo: marketRepo, dir };
  }
  if (src && typeof src === 'object') {
    const repo = src.repo || repoFromUrl(src.url);
    if (repo) return { repo, dir: (src.path || '').replace(/^\.?\/|\/$/g, '') };
  }
  return marketRepo ? { repo: marketRepo, dir: '' } : null;
}

async function check(plugins, env, token) {
  const knownMarkets = store.readJson(path.join(store.PLUGINS_DIR, 'known_marketplaces.json'), {});
  const markets = store.listMarketplaces();
  const heads = new Map();
  const compares = new Map();
  const result = {};
  const errors = new Set();

  for (const p of plugins) {
    const src = sourceOf(p, knownMarkets, markets);
    if (!src || !p.gitCommitSha) continue;
    try {
      if (!heads.has(src.repo)) heads.set(src.repo, gitHead(src.repo, env));
      const head = await heads.get(src.repo);
      if (head.startsWith(p.gitCommitSha) || p.gitCommitSha.startsWith(head)) continue;

      const key = `${src.repo}@${p.gitCommitSha}`;
      if (!compares.has(key)) {
        compares.set(key, getJson(`https://api.github.com/repos/${src.repo}/compare/${p.gitCommitSha}...${head}`, token));
      }
      const cmp = await compares.get(key);
      const files = cmp.files || [];
      const prefix = src.dir ? `${src.dir}/` : '';
      const changed = prefix ? files.filter((f) => f.filename.startsWith(prefix)) : files;
      // The compare API lists at most 300 files; past that, assume the plugin changed.
      if (!changed.length && files.length < 300) continue;
      // In a shared repo (e.g. an official marketplace) keep only commits that touch this plugin's folder.
      let commits = (cmp.commits || []).slice().reverse();
      if (src.dir) {
        // The compare API returns at most 250 commits, so filter the folder's history by date instead.
        const base = cmp.merge_base_commit && cmp.merge_base_commit.commit.committer.date;
        const scoped = await getJson(`https://api.github.com/repos/${src.repo}/commits?path=${encodeURIComponent(src.dir)}`
          + `&sha=${head}&per_page=20`, token).catch(() => []);
        commits = base ? scoped.filter((c) => c.commit.committer.date > base) : scoped;
      }
      const latest = commits[0];
      result[p.id] = {
        repo: src.repo,
        behind: src.dir ? Math.max(1, commits.length) : cmp.ahead_by,
        files: changed.length,
        date: latest && latest.commit && latest.commit.committer ? latest.commit.committer.date : undefined,
        messages: commits.slice(0, 5).map((c) => c.commit.message.split('\n')[0]),
        head,
      };
    } catch (e) {
      errors.add(e.message);
    }
  }
  return { updates: result, errors: [...errors], checkedAt: Date.now() };
}

module.exports = { check };
