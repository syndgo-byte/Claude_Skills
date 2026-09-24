'use strict';
// Counts how often each plugin was used, from local Claude Code transcripts (~/.claude/projects/**/*.jsonl).
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { CLAUDE_DIR } = require('./store');

const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

function listTranscripts(sinceMs) {
  const out = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { if (fs.statSync(p).mtimeMs >= sinceMs) out.push(p); } catch { /* removed meanwhile */ }
      }
    }
  };
  walk(PROJECTS_DIR, 0);
  return out;
}

// Maps a used name to a plugin: "superpowers:brainstorming" -> superpowers; "/commit" -> the plugin that owns it.
function makeResolver(plugins) {
  const byPrefix = new Map(plugins.map((p) => [p.name.toLowerCase(), p.id]));
  const byItem = new Map();
  for (const p of plugins) {
    for (const kind of ['skills', 'commands', 'agents']) {
      for (const x of p.components[kind]) {
        const k = x.name.toLowerCase();
        // Ambiguous short names are not credited to anyone.
        byItem.set(k, byItem.has(k) && byItem.get(k) !== p.id ? null : p.id);
      }
    }
  }
  return (raw) => {
    const name = raw.replace(/^\//, '').toLowerCase();
    const i = name.indexOf(':');
    if (i > 0) return byPrefix.get(name.slice(0, i)) || null;
    return byItem.get(name) || null;
  };
}

// Uses found in one transcript entry. Only real structure counts: text that merely mentions a skill
// (in a prompt, a file, or a tool result) is ignored.
function usesIn(entry) {
  const found = [];
  const msg = entry.message;
  if (!msg) return found;
  if (entry.type === 'assistant' && Array.isArray(msg.content)) {
    for (const c of msg.content) {
      if (c.type !== 'tool_use') continue;
      if (c.name === 'Skill' && c.input && c.input.skill) found.push({ kind: 'skill', name: c.input.skill });
      else if (c.input && typeof c.input.subagent_type === 'string' && c.input.subagent_type.includes(':')) {
        found.push({ kind: 'agent', name: c.input.subagent_type });
      } else if (typeof c.name === 'string' && c.name.startsWith('mcp__plugin_')) {
        found.push({ kind: 'mcp', name: c.name.slice('mcp__plugin_'.length).split('_')[0] });
      }
    }
  } else if (entry.type === 'user') {
    // A slash command the user typed arrives as a user message that starts with <command-name>.
    const text = typeof msg.content === 'string' ? msg.content
      : Array.isArray(msg.content) ? msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : '';
    const m = text.match(/^\s*(?:<command-message>[\s\S]*?<\/command-message>\s*)?<command-name>\/?([^<\s]+)<\/command-name>/);
    if (m) found.push({ kind: 'command', name: m[1] });
  }
  return found;
}

async function analyze(plugins, days) {
  const sinceMs = Date.now() - days * 86400000;
  const resolve = makeResolver(plugins);
  const mcpOwner = new Map(plugins.map((p) => [p.name.toLowerCase(), p.id]));
  const stats = Object.fromEntries(plugins.map((p) => [p.id, { count: 0, last: null, items: {} }]));
  let sessions = 0;

  for (const file of listTranscripts(sinceMs)) {
    sessions++;
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.indexOf('Skill') < 0 && line.indexOf('command-name') < 0
        && line.indexOf('subagent_type') < 0 && line.indexOf('mcp__plugin_') < 0) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const when = entry.timestamp ? Date.parse(entry.timestamp) : 0;
      if (when && when < sinceMs) continue;
      for (const u of usesIn(entry)) {
        const id = u.kind === 'mcp' ? mcpOwner.get(u.name.toLowerCase()) : resolve(u.name);
        if (!id || !stats[id]) continue;
        const s = stats[id];
        const label = u.kind === 'mcp' ? `MCP ${u.name}` : u.name;
        s.count++;
        s.items[label] = (s.items[label] || 0) + 1;
        if (when && (!s.last || when > s.last)) s.last = when;
      }
    }
  }
  return { stats, sessions, days, analyzedAt: Date.now() };
}

// Plugins made only of hooks or LSP servers run on their own, so transcripts cannot show how much they are used.
function isAutomatic(p) {
  const c = p.components;
  return !c.skills.length && !c.commands.length && !c.agents.length && !c.mcpServers.length
    && (c.hooks.length > 0 || c.lspServers.length > 0);
}

module.exports = { analyze, isAutomatic };
