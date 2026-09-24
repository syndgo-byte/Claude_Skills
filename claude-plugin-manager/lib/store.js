'use strict';
// Reads and writes Claude Code plugin state under ~/.claude.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const PLUGINS_DIR = path.join(CLAUDE_DIR, 'plugins');
const INSTALLED_FILE = path.join(PLUGINS_DIR, 'installed_plugins.json');
const MARKETPLACES_DIR = path.join(PLUGINS_DIR, 'marketplaces');

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function readDir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}

// Minimal YAML frontmatter reader: flat keys, quoted values, and > / | block scalars.
function parseFrontmatter(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch { return {}; }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let [, key, value] = kv;
    if (/^[>|][+-]?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) {
        block.push(lines[++i].trim());
      }
      value = block.join(value.startsWith('|') ? '\n' : ' ').trim();
    } else {
      value = value.trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    }
    out[key] = value;
  }
  return out;
}

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

// Collect SKILL.md files: a path is either a skill dir or a dir of skill dirs.
function collectSkills(root, dirs) {
  const skills = [];
  const seen = new Set();
  const add = (dir) => {
    const file = path.join(dir, 'SKILL.md');
    if (seen.has(file) || !exists(file)) return false;
    seen.add(file);
    const fm = parseFrontmatter(file);
    skills.push({ name: fm.name || path.basename(dir), description: fm.description || '', file });
    return true;
  };
  for (const rel of dirs) {
    const dir = path.resolve(root, rel);
    if (!isDir(dir) || add(dir)) continue;
    for (const child of readDir(dir)) {
      const sub = path.join(dir, child);
      if (isDir(sub)) add(sub);
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function collectMarkdown(root, dirs) {
  const items = [];
  for (const rel of dirs) {
    const dir = path.resolve(root, rel);
    const files = isDir(dir) ? readDir(dir).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f))
      : (dir.endsWith('.md') && exists(dir) ? [dir] : []);
    for (const file of files) {
      const fm = parseFrontmatter(file);
      items.push({ name: fm.name || path.basename(file, '.md'), description: fm.description || '', file });
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

function scanComponents(root, manifest, marketEntry) {
  const m = { ...(marketEntry || {}), ...(manifest || {}) };
  const skillDirs = asArray(m.skills).length ? asArray(m.skills) : ['skills'];
  const commandDirs = asArray(m.commands).length ? asArray(m.commands) : ['commands'];
  const agentDirs = asArray(m.agents).length ? asArray(m.agents) : ['agents'];

  const hookEvents = new Set();
  const hookSources = [m.hooks, readJson(path.join(root, 'hooks', 'hooks.json'), null)];
  for (const h of hookSources) {
    const obj = h && typeof h === 'object' ? (h.hooks || h) : null;
    if (obj) Object.keys(obj).forEach((k) => hookEvents.add(k));
  }

  const mcp = { ...(readJson(path.join(root, '.mcp.json'), {}).mcpServers || {}),
    ...(typeof m.mcpServers === 'object' ? m.mcpServers : {}) };
  const lsp = typeof m.lspServers === 'object' ? m.lspServers : {};

  return {
    skills: collectSkills(root, skillDirs),
    commands: collectMarkdown(root, commandDirs),
    agents: collectMarkdown(root, agentDirs),
    hooks: [...hookEvents],
    mcpServers: Object.keys(mcp),
    lspServers: Object.keys(lsp),
  };
}

function readSettings() {
  return readJson(SETTINGS_FILE, {});
}

function listMarketplaces() {
  const result = [];
  for (const dir of readDir(MARKETPLACES_DIR)) {
    const file = path.join(MARKETPLACES_DIR, dir, '.claude-plugin', 'marketplace.json');
    const data = readJson(file, null);
    if (!data) continue;
    result.push({ name: data.name || dir, dir: path.join(MARKETPLACES_DIR, dir), plugins: data.plugins || [] });
  }
  return result;
}

function findMarketEntry(markets, pluginName, marketName) {
  const market = markets.find((mk) => mk.name === marketName);
  return market ? market.plugins.find((p) => p.name === pluginName) : undefined;
}

function listInstalled() {
  const installed = readJson(INSTALLED_FILE, { plugins: {} }).plugins || {};
  const enabled = readSettings().enabledPlugins || {};
  const markets = listMarketplaces();
  const list = [];
  for (const [id, entries] of Object.entries(installed)) {
    const entry = asArray(entries).find((e) => e.scope === 'user') || asArray(entries)[0];
    if (!entry) continue;
    const [name, marketplace] = id.split('@');
    const root = entry.installPath;
    const manifest = readJson(path.join(root, '.claude-plugin', 'plugin.json'), null);
    const marketEntry = findMarketEntry(markets, name, marketplace);
    const info = { ...(marketEntry || {}), ...(manifest || {}) };
    let homepage = info.homepage || info.repository;
    if (homepage && typeof homepage === 'object') homepage = homepage.url;
    list.push({
      id, name, marketplace,
      version: entry.version,
      gitCommitSha: entry.gitCommitSha,
      installedAt: entry.installedAt,
      scope: entry.scope,
      root,
      enabled: enabled[id] === true,
      description: info.description || '',
      author: info.author && (info.author.name || info.author),
      homepage: typeof homepage === 'string' ? homepage : undefined,
      keywords: info.keywords || [],
      components: scanComponents(root, manifest, marketEntry),
    });
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

// Rewrites only enabledPlugins and leaves every other settings key as is.
function setEnabled(changes) {
  const settings = readSettings();
  settings.enabledPlugins = settings.enabledPlugins || {};
  for (const [id, on] of Object.entries(changes)) settings.enabledPlugins[id] = !!on;
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

// Personal skills live in ~/.claude/skills/<name>/SKILL.md. Claude Code has no switch for them,
// so "off" means the folder is moved to ~/.claude/skills-disabled/.
const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');
const DISABLED_SKILLS_DIR = path.join(CLAUDE_DIR, 'skills-disabled');

function listPersonalSkills() {
  const out = [];
  for (const [dir, enabled] of [[SKILLS_DIR, true], [DISABLED_SKILLS_DIR, false]]) {
    for (const name of readDir(dir)) {
      const root = path.join(dir, name);
      const file = path.join(root, 'SKILL.md');
      if (name === 'synced' || !isDir(root) || !exists(file)) continue;
      const fm = parseFrontmatter(file);
      const scripts = readDir(path.join(root, 'scripts'));
      out.push({ id: `skill:${name}`, name: fm.name || name, folder: name, root, file, enabled,
        description: fm.description || '', scripts });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function setPersonalSkillEnabled(skill, on) {
  const from = skill.root;
  const to = path.join(on ? SKILLS_DIR : DISABLED_SKILLS_DIR, skill.folder);
  if (from === to) return;
  if (exists(to)) throw new Error(`${to} 이미 있음`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

module.exports = {
  CLAUDE_DIR, SETTINGS_FILE, PLUGINS_DIR, INSTALLED_FILE, MARKETPLACES_DIR, SKILLS_DIR,
  listInstalled, listMarketplaces, setEnabled, readJson, parseFrontmatter,
  listPersonalSkills, setPersonalSkillEnabled,
};
