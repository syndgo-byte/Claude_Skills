'use strict';
// Router settings and log in ~/.claude/token-router/.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.claude', 'token-router');
const STATE_FILE = path.join(DIR, 'state.json');
const LOG_FILE = path.join(DIR, 'log.jsonl');

function load() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { enabled: true }; }
}

function save(st) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2) + '\n', 'utf8');
}

function log(entry) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch { /* logging must never break routing */ }
}

function stats(days = 30) {
  let lines = [];
  try { lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n'); } catch { return '기록 없음'; }
  const since = Date.now() - days * 86400000;
  const routes = {};
  const by = {};
  for (const l of lines) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    if (e.type !== 'route' || Date.parse(e.ts) < since) continue;
    routes[e.route] = (routes[e.route] || 0) + 1;
    by[e.by || 'rules'] = (by[e.by || 'rules'] || 0) + 1;
  }
  const total = Object.values(routes).reduce((a, b) => a + b, 0);
  const st = load();
  return [
    `최근 ${days}일 판정 ${total}건`,
    ...Object.entries(routes).sort((a, b) => b[1] - a[1]).map(([r, n]) => `  ${r}: ${n}`),
    `판정 방식: ${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(', ') || '-'}`,
    `설정: 라우팅 ${st.enabled === false ? '꺼짐' : '켜짐'} · 무료 AI 판별 ${st.llm === true ? '켜짐' : '꺼짐'}`
      + ` · Fable ${st.allowFable ? '허용' : '금지'}`
      + ` · 전환 제안: ${st.askAt || 'opus'} 이상일 때 상향, 하향 ${st.down === false ? '꺼짐' : '켜짐'}`,
  ].join('\n');
}

// Where handoffs and backups go. A session that edited files (a .py, a config...) belongs to the
// project those files live in: the nearest folder above them with a project marker, or the file's
// own folder. A session that only ran commands has no project; its handoffs go to one shared
// folder (default D:\Claude_handoff) and nothing is backed up.
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const inside = (dir, f) => { const r = path.relative(dir, f); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
const MARKERS = ['.git', 'pyproject.toml', 'package.json', 'requirements.txt', 'setup.py', 'go.mod', 'Cargo.toml',
  'pom.xml', 'build.gradle', 'CLAUDE.md', '.vscode'];
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

function fallbackDir() {
  const st = load();
  if (st.handoffHome) return st.handoffHome;
  return process.platform === 'win32' && fs.existsSync('D:\\') ? 'D:\\Claude_handoff' : path.join(os.homedir(), 'Claude_handoff');
}

// Edits that are not project work: settings, temp/scratch files, handoffs and backups themselves.
function ignoredEdit(f) {
  const n = path.resolve(f);
  return /^handoff-\d{4}-\d{4}\.md$/.test(path.basename(n)) || n.split(/[\\/]/).includes('backup-claude')
    || inside(path.join(os.homedir(), '.claude'), n) || inside(os.tmpdir(), n) || inside(fallbackDir(), n);
}

function projectRootOf(file) {
  const home = os.homedir();
  const start = path.dirname(path.resolve(file));
  for (let d = start; ; d = path.dirname(d)) {
    if (MARKERS.some((m) => fs.existsSync(path.join(d, m)))) return d;
    if (same(d, home) || path.dirname(d) === d) return start;
  }
}

// The project this session worked on: the root with the most edits in the transcript.
function editedProject(transcript) {
  let text;
  try { text = fs.readFileSync(transcript, 'utf8'); } catch { return null; }
  const count = new Map();
  for (const l of text.split('\n')) {
    if (!l.includes('"tool_use"') || !l.includes('_path"')) continue;
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    for (const b of (e.message && Array.isArray(e.message.content) ? e.message.content : [])) {
      if (b.type !== 'tool_use' || !EDIT_TOOLS.includes(b.name)) continue;
      const f = (b.input || {}).file_path || (b.input || {}).notebook_path;
      if (!f || ignoredEdit(f)) continue;
      const root = projectRootOf(f);
      count.set(root, (count.get(root) || 0) + 1);
    }
  }
  let best = null;
  for (const [root, n] of count) if (!best || n >= best[1]) best = [root, n];
  return best && best[0];
}

const handoffDir = (transcript) => (transcript && editedProject(transcript)) || fallbackDir();

// Snapshot safety net: never back up a home folder, a drive root or Desktop/Downloads/Documents.
function isProject(dir) {
  const d = path.resolve(dir || process.cwd());
  const home = os.homedir();
  if (same(d, path.parse(d).root) || same(d, home)) return false;
  return !['Desktop', 'Downloads', 'Documents', 'OneDrive', '바탕 화면', '다운로드', '문서']
    .some((n) => same(d, path.join(home, n)));
}

// Every handoff written, wherever it lives, so a new session can offer it from any folder.
const INDEX = path.join(DIR, 'handoffs.json');
function handoffIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return []; }
}
function recordHandoff(file) {
  const list = handoffIndex().filter((x) => !same(x.path, file));
  list.push({ path: file, t: Date.now() });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(INDEX, JSON.stringify(list.slice(-50)), 'utf8');
}

module.exports = { load, save, log, stats, DIR, EDIT_TOOLS, isProject, fallbackDir, editedProject, handoffDir,
  handoffIndex, recordHandoff };
