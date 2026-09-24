#!/usr/bin/env node
'use strict';
// Work journal that costs no tokens: a hook script pulls requests, edited files, commands and the
// latest answer out of the transcript and appends them to <project>/.handoff/journal-*.md.
// It writes every N user turns, and always before compaction or when the session ends, so the
// next session (or another tool) can pick up from the file instead of the whole conversation.
//
//   node journal.js hook                 -> Stop / PreCompact / SessionEnd hook (reads hook JSON on stdin)
//   node journal.js now [transcript]     -> write what is new right away
//   node journal.js --every <N>          -> write every N turns (default 5)
const fs = require('fs');
const path = require('path');
const state = require('./state');

const DEFAULT_EVERY = 5;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const clip = (s, n) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

// A real prompt, not a tool result or a slash-command wrapper.
function promptText(e) {
  if (e.type !== 'user' || e.isMeta) return null;
  const c = (e.message || {}).content;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c) && !c.some((b) => b.type === 'tool_result')) {
    text = c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') || null;
  }
  if (!text || /^\s*<(command-|local-command)/.test(text)) return null;
  return text;
}

function readEntries(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  });
}

function summarize(entries) {
  const prompts = [];
  const edits = new Map();
  const commands = [];
  const models = new Set();
  let lastText = '';
  let context = 0;
  for (const e of entries) {
    if (!e) continue;
    const p = promptText(e);
    if (p) prompts.push(p);
    if (e.type !== 'assistant') continue;
    const msg = e.message || {};
    if (msg.model && !msg.model.startsWith('<')) models.add(msg.model);
    const u = msg.usage;
    if (u) context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b.type === 'text' && b.text.trim()) lastText = b.text;
      if (b.type !== 'tool_use') continue;
      const input = b.input || {};
      if (EDIT_TOOLS.has(b.name)) {
        const f = input.file_path || input.notebook_path;
        if (f) edits.set(f, (edits.get(f) || 0) + 1);
      } else if (b.name === 'Bash' && input.command) {
        commands.push(input.description ? `${clip(input.command, 100)} — ${clip(input.description, 60)}` : clip(input.command, 140));
      }
    }
  }
  return { prompts, edits, commands, models: [...models], lastText, context };
}

function render(s, fromTurn, reason, root) {
  // Paths inside the project are shown relative to it; they are shorter to read.
  const rel = (f) => { const r = path.relative(root, f); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : f; };
  const d = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const turns = s.prompts.length ? `턴 ${fromTurn}–${fromTurn + s.prompts.length - 1}` : '추가 턴 없음';
  const out = [`## ${hhmm} · ${turns} · ${s.models.join(', ') || '-'} · 맥락 ${Math.round(s.context / 1000)}k${reason ? ` · ${reason}` : ''}`, ''];
  if (s.prompts.length) out.push('**요청**', ...s.prompts.map((p) => `- ${clip(p, 200)}`), '');
  if (s.edits.size) out.push('**수정한 파일**', ...[...s.edits].map(([f, n]) => `- \`${rel(f)}\`${n > 1 ? ` ×${n}` : ''}`), '');
  if (s.commands.length) {
    const cmds = s.commands.slice(-10);
    out.push('**실행한 명령**' + (s.commands.length > cmds.length ? ` (최근 ${cmds.length}개)` : ''), ...cmds.map((c) => `- \`${c}\``), '');
  }
  if (s.lastText) out.push('**마지막 답변 (앞부분)**', `> ${clip(s.lastText, 400)}`, '');
  return out.join('\n') + '\n';
}

// force: write even if fewer than N turns passed (compaction, session end, manual).
function write({ transcript, sessionId, cwd, force, reason }) {
  if (!transcript) return null;
  let entries;
  try { entries = readEntries(transcript); } catch { return null; }
  const st = state.load();
  const every = st.journalEvery || DEFAULT_EVERY;
  const cursors = st.journalCursor || {};
  const key = sessionId || path.basename(transcript, '.jsonl');
  let cur = cursors[key] || { line: 0, turn: 1 };
  if (cur.line > entries.length) cur = { line: 0, turn: 1 }; // transcript was replaced
  const fresh = entries.slice(cur.line);
  const s = summarize(fresh);
  if (!s.prompts.length && !s.edits.size && !s.commands.length) return null;
  if (!force && s.prompts.length < every) return null;

  const root = cwd || process.cwd();
  const dir = path.join(root, '.handoff');
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const file = path.join(dir, `journal-${p(d.getMonth() + 1)}${p(d.getDate())}-${key.slice(0, 8)}.md`);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# 작업 일지 (${key.slice(0, 8)})\n\n자동 기록: 요청·수정 파일·명령만 담기며 판단 근거는 없음. 인수인계는 handoff-*.md 참고.\n\n`, 'utf8');
  }
  fs.appendFileSync(file, render(s, cur.turn, reason, root), 'utf8');

  cursors[key] = { line: entries.length, turn: cur.turn + s.prompts.length };
  st.journalCursor = Object.fromEntries(Object.entries(cursors).slice(-50));
  state.save(st);
  state.log({ type: 'journal', turns: s.prompts.length, reason: reason || 'turns' });
  return file;
}

// Stop hook output never reaches Claude's context, so this stays silent and always exits 0.
function hook() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return; }
  const event = input.hook_event_name;
  const reason = event === 'PreCompact' ? '압축 전' : event === 'SessionEnd' ? '세션 종료' : '';
  try {
    write({ transcript: input.transcript_path, sessionId: input.session_id, cwd: input.cwd, force: event !== 'Stop', reason });
  } catch { /* a journal failure must never block the session */ }
}

function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'hook') return hook();
  if (cmd === '--every') {
    const n = Math.floor(Number(arg));
    if (!(n > 0)) { console.error('usage: node journal.js --every <N>'); process.exit(2); }
    const st = state.load();
    st.journalEvery = n;
    state.save(st);
    return console.log(`일지 기록 주기: ${n}턴마다`);
  }
  if (cmd === 'now') {
    const transcript = arg || require('./handoff').latestTranscript();
    const file = write({ transcript, force: true, reason: '수동' });
    return console.log(file ? `기록함: ${file}` : '새로 기록할 내용 없음');
  }
  console.error('usage: node journal.js hook | now [transcript.jsonl] | --every <N>');
  process.exit(2);
}

if (require.main === module) main();
module.exports = { write, summarize };
