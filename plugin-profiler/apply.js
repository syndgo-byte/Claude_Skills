#!/usr/bin/env node
'use strict';
// SessionStart hook entry point: reads hook JSON from stdin (Claude Code passes {cwd, ...}),
// decides a plugin profile for that project with profile.js, and writes it to settings.json.
// Runs at the very start of a session, before the skill/command listing is built for that
// session — this is the one point where an enable/disable change can affect the session that
// is about to start, unlike mid-session changes which only take effect next time.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decide, applyDecision, ALWAYS_ON } = require('./profile');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const INSTALLED_FILE = path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json');
const MARKETPLACES_DIR = path.join(CLAUDE_DIR, 'plugins', 'marketplaces');
const CACHE_DIR = path.join(CLAUDE_DIR, 'plugins', 'cache');

// 플러그인 복구 메타데이터: [플러그인명, 마켓플레이스, 캐시폴더명]
const PLUGIN_META = [
  ['context7', 'context7-marketplace', 'context7'],
  ['claude-md-management', 'claude-plugins-official', 'claude-md-management'],
  ['frontend-design', 'claude-plugins-official', 'frontend-design'],
  ['pyright-lsp', 'claude-plugins-official', 'pyright-lsp'],
  ['andrej-karpathy-skills', 'karpathy-skills', 'andrej-karpathy-skills'],
  ['academy-guide', 'anthropic-agent-skills', 'academy-guide'],
  ['claude-api', 'anthropic-agent-skills', 'claude-api'],
  ['discernment-nudge', 'anthropic-agent-skills', 'discernment-nudge'],
  ['document-skills', 'anthropic-agent-skills', 'document-skills'],
];

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function restoreMissingPlugin(marketplace, cacheName) {
  const cachePluginPath = path.join(CACHE_DIR, marketplace, cacheName);
  if (!fs.existsSync(cachePluginPath)) return null;

  const versions = fs.readdirSync(cachePluginPath)
    .filter(v => /^\d+\.\d+/.test(v) || /^[a-f0-9]{12}$/.test(v))
    .sort()
    .reverse();

  if (versions.length === 0) return null;

  const version = versions[0];
  const versionPath = path.join(cachePluginPath, version);

  // git commit sha 찾기
  let gitCommitSha = '';
  try {
    const gitHeadPath = path.join(versionPath, '.git', 'HEAD');
    if (fs.existsSync(gitHeadPath)) {
      const headContent = fs.readFileSync(gitHeadPath, 'utf8').trim();
      if (headContent.startsWith('ref: ')) {
        const refPath = path.join(versionPath, '.git', headContent.substring(5));
        if (fs.existsSync(refPath)) {
          gitCommitSha = fs.readFileSync(refPath, 'utf8').trim();
        }
      } else {
        gitCommitSha = headContent;
      }
    }
  } catch (e) {
    gitCommitSha = '';
  }

  if (!gitCommitSha || gitCommitSha.length < 40) {
    gitCommitSha = version.substring(0, 40) || '0000000000000000000000000000000000000000';
  }

  return {
    scope: 'user',
    installPath: versionPath,
    version: version,
    installedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    gitCommitSha: gitCommitSha.substring(0, 40)
  };
}

function ensureAlwaysOnPlugins() {
  const installed = readJson(INSTALLED_FILE, { version: 2, plugins: {} });
  if (!installed.plugins) installed.plugins = {};

  let restored = 0;
  for (const [pluginName, marketplace, cacheName] of PLUGIN_META) {
    const key = `${pluginName}@${marketplace}`;
    if (!installed.plugins[key]) {
      const info = restoreMissingPlugin(marketplace, cacheName);
      if (info) {
        installed.plugins[key] = [info];
        restored++;
      }
    }
  }

  if (restored > 0) {
    fs.writeFileSync(INSTALLED_FILE, JSON.stringify(installed, null, 2) + '\n');
  }
  return restored;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 1500); // don't let a stuck stdin block the hook past its timeout
  });
}

async function main() {
  // 세션 시작 전: ALWAYS_ON 플러그인이 missing되면 자동 복구
  const restored = ensureAlwaysOnPlugins();

  const raw = await readStdin();
  let cwd = process.cwd();
  try {
    const input = JSON.parse(raw);
    if (input.cwd) cwd = input.cwd;
  } catch { /* fall back to process.cwd() */ }

  const dryRun = process.argv.includes('--dry-run');
  const { enabled, reasons } = await decide(cwd);
  const changes = applyDecision(cwd, enabled, reasons, dryRun);

  if (restored > 0 && !dryRun) {
    reasons._restored = `${restored}개 플러그인 자동 복구됨`;
  }

  if (process.argv.includes('--verbose') || dryRun) {
    console.log(JSON.stringify({ cwd, changes, reasons, restored }, null, 2));
  }
}

main().catch((e) => {
  // A hook that throws must not break session start; log and exit clean.
  try { require('fs').appendFileSync(require('path').join(__dirname, 'decisions.log'), `[error] ${e.stack}\n`); } catch {}
  process.exit(0);
});
