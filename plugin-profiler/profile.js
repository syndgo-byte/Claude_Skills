'use strict';
// Decides which installed Claude Code plugins should be enabled for the project about to open,
// using only local data (past usage in this exact project, file types present). No LLM calls.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const INSTALLED_FILE = path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json');
const LOG_FILE = path.join(__dirname, 'decisions.log');

// Tier 1: cheap plugins (few skills/commands, no hooks) — always on, their per-turn cost is small.
const ALWAYS_ON = [
  'context7@context7-marketplace',
  'commit-commands@claude-plugins-official',
  'claude-md-management@claude-plugins-official',
  'frontend-design@claude-plugins-official',
  'andrej-karpathy-skills@karpathy-skills',
  'academy-guide@anthropic-agent-skills',
  'claude-api@anthropic-agent-skills',
  'discernment-nudge@anthropic-agent-skills',
  'receipts@claude-plugins-official',
  'document-skills@anthropic-agent-skills',
  'pyright-lsp@claude-plugins-official',
];

// Tier 2: heavy plugins (15-25 skills, or hooks firing on nearly every tool call). Only turned on
// for a project where they have a real, recent track record of being used — or a strong file-type
// match, for a project that has never used them but clearly could (e.g. a fresh project full of
// docx files matching document-skills-style plugins). Everything else in this tier stays off.
const HEAVY = {
  'superpowers@superpowers-marketplace': { keywords: [] }, // no reliable file-type signal; usage-only
  'planning-with-files@planning-with-files': { keywords: [] },
  'mattpocock-skills@mattpocock': { keywords: [] },
  'caveman@caveman': { keywords: [] }, // never auto-enabled by file type; opt in by use or by hand
  'example-skills@anthropic-agent-skills': { keywords: ['.png', '.svg', '.pptx', '.gif'] },
  'security-guidance@claude-plugins-official': { keywords: [] }, // opt in explicitly; spends real API tokens
};

const USAGE_WINDOW_DAYS = 60;
const USAGE_THRESHOLD = 3; // real, repeated use in this project, not a one-off

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return fallback; }
}

function listTranscriptsForCwd(cwd, sinceMs) {
  const out = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 2) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { if (fs.statSync(p).mtimeMs >= sinceMs) out.push(p); } catch { /* removed meanwhile */ }
      }
    }
  };
  walk(PROJECTS_DIR, 0);
  return out;
}

// A skill/command/agent name -> the plugin id that provides it (personal skills are not counted here;
// only marketplace plugins matter for enable/disable).
function buildResolver(installedIndex) {
  const byPrefix = new Map();
  const byItem = new Map();
  for (const [id, info] of Object.entries(installedIndex)) {
    byPrefix.set(id.split('@')[0].toLowerCase(), id);
    for (const name of info.items || []) {
      const k = name.toLowerCase();
      byItem.set(k, byItem.has(k) && byItem.get(k) !== id ? null : id);
    }
  }
  return (raw) => {
    const name = raw.replace(/^\//, '').toLowerCase();
    const i = name.indexOf(':');
    if (i > 0) return byPrefix.get(name.slice(0, i)) || null;
    return byItem.get(name) || null;
  };
}

async function usesInProject(cwd, installedIndex) {
  const sinceMs = Date.now() - USAGE_WINDOW_DAYS * 86400000;
  const resolve = buildResolver(installedIndex);
  const counts = {};
  const cwdMatch = `"cwd":${JSON.stringify(cwd)}`;
  for (const file of listTranscriptsForCwd(cwd, sinceMs)) {
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes(cwdMatch)) continue; // cheap pre-filter before JSON.parse
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.cwd !== cwd) continue;
      const msg = entry.message;
      if (!msg) continue;
      if (entry.type === 'assistant' && Array.isArray(msg.content)) {
        for (const c of msg.content) {
          if (c.type !== 'tool_use') continue;
          let name = null;
          if (c.name === 'Skill' && c.input && c.input.skill) name = c.input.skill;
          else if (c.input && typeof c.input.subagent_type === 'string') name = c.input.subagent_type;
          if (!name) continue;
          const id = resolve(name);
          if (id) counts[id] = (counts[id] || 0) + 1;
        }
      } else if (entry.type === 'user') {
        const text = typeof msg.content === 'string' ? msg.content : '';
        const m = text.match(/<command-name>\/?([^<\s]+)<\/command-name>/);
        if (m) {
          const id = resolve(m[1]);
          if (id) counts[id] = (counts[id] || 0) + 1;
        }
      }
    }
  }
  return counts;
}

// A home directory or other non-project root produces noisy file-type matches (some stray .png
// three folders deep means nothing). Only trust file types when the folder itself looks like an
// actual project: a repo, or a manifest file at its root.
function looksLikeProject(cwd) {
  const markers = ['.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml',
    'go.mod', '.claude-plugin', 'pom.xml', '*.sln'];
  let entries = [];
  try { entries = fs.readdirSync(cwd); } catch { return false; }
  const set = new Set(entries);
  if (markers.some((m) => set.has(m))) return true;
  return entries.some((e) => /\.(sln|csproj)$/i.test(e));
}

// Same rough profile the plugin recommender uses: file extensions present in the workspace.
function fileTypesIn(cwd) {
  if (!looksLikeProject(cwd)) return new Set();
  const exts = new Set();
  const skip = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', '__pycache__']);
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
      else exts.add(path.extname(e.name).toLowerCase());
    }
  };
  walk(cwd, 0);
  return exts;
}

// Builds { installPath -> { items: [...] } } from installed_plugins.json + each plugin's own scan,
// trimmed down to just what this script needs (skill/command/agent names for resolving hits).
function loadInstalledIndex() {
  const installed = readJson(INSTALLED_FILE, { plugins: {} }).plugins || {};
  const index = {};
  for (const [id, entries] of Object.entries(installed)) {
    const entry = (Array.isArray(entries) ? entries : [entries]).find((e) => e.scope === 'user') || entries[0];
    if (!entry) continue;
    const root = entry.installPath;
    const manifest = readJson(path.join(root, '.claude-plugin', 'plugin.json'), {});
    const items = [];
    const collect = (dirs) => {
      for (const rel of dirs) {
        const dir = path.resolve(root, rel);
        let names = [];
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const n of names) {
          const sub = path.join(dir, n);
          if (fs.existsSync(path.join(sub, 'SKILL.md'))) items.push(n);
          else if (n.endsWith('.md')) items.push(path.basename(n, '.md'));
        }
      }
    };
    collect([].concat(manifest.skills || 'skills'));
    collect([].concat(manifest.commands || 'commands'));
    collect([].concat(manifest.agents || 'agents'));
    index[id] = { root, items };
  }
  return index;
}

async function decide(cwd) {
  const installedIndex = loadInstalledIndex();
  const installedIds = new Set(Object.keys(installedIndex));
  const usage = await usesInProject(cwd, installedIndex);
  const exts = fileTypesIn(cwd);

  const enabled = {};
  const reasons = {};
  for (const id of ALWAYS_ON) {
    if (!installedIds.has(id)) continue;
    enabled[id] = true;
    reasons[id] = '항상 켜짐 (가벼움)';
  }
  for (const [id, spec] of Object.entries(HEAVY)) {
    if (!installedIds.has(id)) continue;
    const count = usage[id] || 0;
    const fileHit = spec.keywords.find((ext) => exts.has(ext));
    if (count >= USAGE_THRESHOLD) {
      enabled[id] = true;
      reasons[id] = `이 프로젝트에서 최근 ${USAGE_WINDOW_DAYS}일간 ${count}회 실사용`;
    } else if (fileHit) {
      enabled[id] = true;
      reasons[id] = `프로젝트에 ${fileHit} 파일 있음`;
    } else {
      enabled[id] = false;
      reasons[id] = count > 0 ? `사용 ${count}회 (기준 ${USAGE_THRESHOLD}회 미만)` : '미사용';
    }
  }
  return { enabled, reasons };
}

function applyDecision(cwd, enabled, reasons, dryRun) {
  const settings = readJson(SETTINGS_FILE, {});
  const current = settings.enabledPlugins || {};
  const changes = {};
  for (const [id, on] of Object.entries(enabled)) {
    if (current[id] !== on) changes[id] = on;
  }
  const lines = [`[${new Date().toISOString()}] cwd=${cwd}`];
  for (const [id, on] of Object.entries(enabled)) lines.push(`  ${on ? 'ON ' : 'OFF'} ${id} — ${reasons[id]}`);
  if (Object.keys(changes).length) {
    lines.push(`  변경: ${Object.entries(changes).map(([id, on]) => `${id}=${on}`).join(', ')} (다음 세션부터 적용)`);
  } else {
    lines.push('  변경 없음');
  }
  try { fs.appendFileSync(LOG_FILE, lines.join('\n') + '\n\n', 'utf8'); } catch { /* logging is best-effort */ }

  if (dryRun || !Object.keys(changes).length) return changes;
  settings.enabledPlugins = { ...current, ...changes };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return changes;
}

module.exports = { decide, applyDecision, ALWAYS_ON, HEAVY, USAGE_THRESHOLD, USAGE_WINDOW_DAYS };
