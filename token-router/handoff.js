#!/usr/bin/env node
'use strict';
// Session split: every turn re-reads the whole conversation, so a long session costs more per
// answer. This measures how big the current context is and says when to hand off to a new
// session through a handoff-mmdd-hhmm.md file.
//
//   node handoff.js check [transcript.jsonl]  -> JSON {context, turns, model, recommend, file}
//   node handoff.js hook                      -> UserPromptSubmit hook: prints a notice past the threshold
//   node handoff.js guard                     -> PostToolUse hook: stops a long tool loop past the loop threshold
//   node handoff.js start                     -> SessionStart hook: offers to continue from the latest handoff
//   node handoff.js used <file>               -> file a handoff away in .handoff/done/ once it has been picked up
//   node handoff.js --toast on|off           -> Windows balloon + sound with the warnings (default on)
//   node handoff.js where [transcript]        -> where this session's handoff would go
//   node handoff.js --home <dir>              -> handoff folder for sessions that edited no files (default D:\Claude_handoff)
//   node handoff.js name                      -> handoff-mmdd-hhmm.md for now
//   node handoff.js --threshold <tokens>      -> when to recommend a new session (default 80000)
//   node handoff.js --loop <tokens>           -> when to stop a tool loop mid-prompt (default 150000)
const fs = require('fs');
const os = require('os');
const path = require('path');
const state = require('./state');

const DEFAULT_THRESHOLD = 80000;
const DEFAULT_LOOP = 150000;

// Per-session memory lives in its own small file: hooks for the same event run in parallel,
// and sharing state.json with them could lose writes.
const sessionFile = (key) => path.join(state.DIR, 'sessions', `${String(key).replace(/[^\w-]/g, '_')}.json`);
function loadSession(key) {
  try { return JSON.parse(fs.readFileSync(sessionFile(key), 'utf8')); } catch { return {}; }
}
function saveSession(key, s) {
  fs.mkdirSync(path.dirname(sessionFile(key)), { recursive: true });
  fs.writeFileSync(sessionFile(key), JSON.stringify(s), 'utf8');
}

function handoffName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `handoff-${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.md`;
}

// Most recently written transcript, for runs outside a hook.
function latestTranscript() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let best = null;
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(root, d)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(root, d, f);
      const t = fs.statSync(full).mtimeMs;
      if (!best || t > best.t) best = { full, t };
    }
  }
  return best && best.full;
}

// Context size = everything the last answer had to read: fresh input plus cache reads and writes.
function measure(file) {
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return null; }
  let context = 0;
  let model = null;
  let turns = 0;
  for (const l of lines) {
    if (!l) continue;
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    const msg = e.message || {};
    if (e.type === 'user' && typeof msg.content === 'string') turns += 1;
    const u = msg.usage;
    if (e.type === 'assistant' && u) {
      context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      model = msg.model || model;
    }
  }
  return { context, turns, model };
}

// Same number as measure(), from the end of the file only: the guard runs after every tool call
// and a long session's transcript can be many megabytes.
function lastContext(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift(); // first line is cut off
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      let e;
      try { e = JSON.parse(lines[i]); } catch { continue; }
      const u = e.type === 'assistant' && e.message && e.message.usage;
      if (u) return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
  const m = measure(file);
  return m && m.context;
}

function check(file) {
  const st = state.load();
  const threshold = st.handoffTokens || DEFAULT_THRESHOLD;
  const m = file && measure(file);
  if (!m) return { error: '대화 기록을 찾지 못함', file: file || null };
  return { ...m, threshold, recommend: m.context >= threshold ? 'new' : 'keep', file };
}

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return {}; }
}

// Hook output is added to Claude's context, so stay silent below the threshold and remind only
// once per threshold step (80k, 160k, ...) instead of on every prompt.
// Windows balloon notification with a sound, for when the chat panel is not in view. Runs detached
// so the hook returns at once; any failure is ignored. Off with --toast off.
function toast(title, text) {
  if (process.platform !== 'win32' || state.load().toast === false) return;
  const q = (s) => String(s).replace(/'/g, "''");
  const ps = 'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;'
    + ' $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Warning; $n.Visible = $true;'
    + ` $n.ShowBalloonTip(10000, '${q(title)}', '${q(text)}', [System.Windows.Forms.ToolTipIcon]::Warning);`
    + ' [System.Media.SystemSounds]::Exclamation.Play(); Start-Sleep -Seconds 11; $n.Dispose()';
  try {
    const c = require('child_process').spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps],
      { detached: true, stdio: 'ignore', windowsHide: true });
    c.unref();
  } catch { /* no PowerShell: the chat message still shows */ }
}

function hook() {
  const input = readStdin();
  const file = input.transcript_path || latestTranscript();
  const key = input.session_id || file;
  const sess = loadSession(key);
  // Once this session has written its handoff, it is over: every further prompt would re-read the
  // whole context. Stop prompts here (the model never sees them, so this is free); /commands pass.
  if (String(input.prompt || '').trim().startsWith('/')) return; // /clear, /model ... pass untouched
  if (sess.handoffWritten) {
    console.log(JSON.stringify({
      decision: 'block',
      reason: `[token-router] 이 대화는 인수인계를 마쳤습니다 (${sess.handoffWritten}). 새 대화(+ 버튼)를 열거나 /clear 를 입력한 뒤 "이어서 해줘"라고 하세요.`
        + ' 여기서 계속하면 대화 전체를 다시 읽어 토큰이 많이 듭니다.',
    }));
    return;
  }
  const prompt = String(input.prompt || '').trim();
  const r = check(file);
  if (r.error || r.recommend !== 'new') return;
  const k = Math.round(r.context / 1000);
  const target = path.join(state.handoffDir(file), handoffName());
  // The user is already moving on: let it through and tell Claude where the handoff goes.
  if (/handoff|핸드오프|인수인계/i.test(prompt)) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit',
      additionalContext: `[token-router] 대화 맥락 약 ${k}k 토큰. handoff는 ${target} 에 token-router 스킬 양식대로 작성하라.` } }));
    return;
  }
  const level = Math.floor(r.context / r.threshold);
  if ((sess.noticeLevel || 0) >= level) return;
  // Stop the first prompt past each threshold step so the warning shows in the chat itself (a
  // plain notice is easy to miss). Free: the model never sees it. Resending the same prompt
  // means "keep going here".
  const hash = require('crypto').createHash('sha1').update(prompt).digest('hex');
  const pending = sess.noticePending || {};
  if (pending.level === level && pending.key === hash) {
    sess.noticeLevel = level;
    delete sess.noticePending;
    saveSession(key, sess);
    state.log({ type: 'handoff-notice-skipped', context: r.context });
    return;
  }
  sess.noticePending = { level, key: hash };
  saveSession(key, sess);
  state.log({ type: 'handoff-notice', context: r.context, turns: r.turns });
  toast('token-router: 새 대화로 넘어갈 때입니다', `대화 맥락 약 ${k}k 토큰 (기준 ${Math.round(r.threshold / 1000)}k)`);
  console.log(JSON.stringify({
    decision: 'block',
    reason: `⚠⚠ [token-router] 대화 맥락 약 ${k}k 토큰 — 새 대화로 넘어갈 때입니다 (기준 ${Math.round(r.threshold / 1000)}k).\n`
      + '지금부터는 질문할 때마다 이 대화 전체를 다시 읽어서 토큰이 빠르게 줄어듭니다.\n'
      + '→ 넘기기: "handoff 해줘" 라고 보내세요. 정리한 뒤 새 대화로 넘어가게 안내합니다.\n'
      + '→ 그냥 계속: 방금 질문을 한 번 더 보내세요.',
  }));
}

// PostToolUse: the prompt hook above only runs between prompts, but one prompt can run a tool
// loop of dozens of calls that grows the context to hundreds of thousands of tokens. Past the
// loop threshold, tell Claude once (per threshold step) to reach a clean stopping point, write a
// handoff and stop. It applies to every prompt, with no opt-out: a long loop is exactly the case
// that burns the limit. The message costs ~150 tokens and lets Claude finish the edit in hand
// rather than stop mid-change.
function guard() {
  const input = readStdin();
  const file = input.transcript_path;
  const st = state.load();
  if (!file) return;
  // A handoff was just written: record where it is, close this session, and tell the user to move on.
  const written = (input.tool_input || {}).file_path || '';
  if (state.EDIT_TOOLS.includes(input.tool_name) && HANDOFF_FILE.test(path.basename(written))) {
    const full = path.resolve(input.cwd || process.cwd(), written);
    state.recordHandoff(full);
    const key = input.session_id || file;
    const sess = loadSession(key);
    sess.handoffWritten = path.basename(full);
    saveSession(key, sess);
    state.log({ type: 'handoff-written', file: full });
    console.log(JSON.stringify({
      systemMessage: `✅ [token-router] 인수인계 파일 작성 완료: ${full}\n새 대화(+ 버튼)를 열거나 /clear 를 입력한 뒤 "이어서 해줘"라고 하세요.`,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: '[token-router] handoff가 작성됐다. 더 작업하지 말고 "새 대화(+)를 열거나 /clear 후 \'이어서 해줘\'라고 하세요" 한 줄만 안내하고 끝내라.',
      },
    }));
    return;
  }
  const limit = st.loopTokens || DEFAULT_LOOP;
  const context = lastContext(file);
  if (!context || context < limit) return;
  const key = input.session_id || file;
  const sess = loadSession(key);
  const level = Math.floor(context / limit);
  if ((sess.loopLevel || 0) >= level) return;
  sess.loopLevel = level;
  saveSession(key, sess);
  state.log({ type: 'loop-guard', context, tool: input.tool_name });
  toast('token-router: 작업을 멈추고 넘깁니다', `맥락 약 ${Math.round(context / 1000)}k 토큰 (기준 ${Math.round(limit / 1000)}k)`);
  const project = state.editedProject(file);
  const target = path.join(project || state.fallbackDir(), handoffName());
  const reason = `[token-router] 맥락이 약 ${Math.round(context / 1000)}k 토큰입니다 (기준 ${Math.round(limit / 1000)}k).`
    + ' 매 호출마다 이 전체를 다시 읽으므로 여기서 끊는 편이 쌉니다.'
    + ' 1) 지금 하던 단위 작업만 마무리해 파일과 테스트를 온전한 상태로 두세요(편집 중간에 멈추지 말 것).'
    + ' 새 파일을 크게 읽거나 긴 출력을 내는 작업은 더 하지 마세요.'
    + (project
      ? ` 2) node "${path.join(__dirname, 'snapshot.js').replace(/\\/g, '/')}" "${project}" 를 실행해 바뀐 파일을 백업하세요(민감 파일 제외, 5GB 이하 자동 유지).`
      : ' 2) 수정한 프로젝트 파일이 없으니 백업은 생략하세요.')
    + ` 3) ${target} 를 token-router 스킬 양식대로 작성하고, "미완료·주의"에 백업 경로·제외 파일·반쯤 된 변경·깨진 테스트·실행 중인 프로세스를 적으세요.`
    + ' 4) 사용자에게 "새 대화(+)를 열거나 /clear 후 이어서 해줘"라고 안내하고 멈추세요.';
  console.log(JSON.stringify({
    decision: 'block',
    reason,
    systemMessage: `⚠ [token-router] 맥락 약 ${Math.round(context / 1000)}k 토큰으로 기준(${Math.round(limit / 1000)}k)을 넘었습니다. 하던 작업을 정리하고 백업·handoff 후 멈춥니다.`,
  }));
}

// SessionStart (new session or /clear): find the newest handoff in the project and have Claude
// offer to continue from it, so nobody has to type the file name. ~80 tokens, only when one exists.
const HANDOFF_FILE = /^handoff-\d{4}-\d{4}\.md$/;
const HANDOFF_MAX_AGE = 7 * 86400000;

function latestHandoff(dir) {
  let best = null;
  let items = [];
  try { items = fs.readdirSync(dir); } catch { return null; }
  for (const f of items) {
    if (!HANDOFF_FILE.test(f)) continue;
    const t = fs.statSync(path.join(dir, f)).mtimeMs;
    if (Date.now() - t <= HANDOFF_MAX_AGE && (!best || t > best.t)) best = { f, t };
  }
  return best && best.f;
}

function goalLine(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const i = lines.findIndex((l) => /^##\s*목표/.test(l));
    const line = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith('#'));
    return line ? line.replace(/^[-*>\s]+/, '').trim().slice(0, 80) : '';
  } catch { return ''; }
}

function start() {
  const input = readStdin();
  if (input.source && !['startup', 'clear'].includes(input.source)) return; // not on resume/compact
  // Candidates: every recorded handoff, plus any in this folder or the shared folder.
  const cands = [];
  const add = (p) => {
    try {
      const t = fs.statSync(p).mtimeMs;
      if (HANDOFF_FILE.test(path.basename(p)) && Date.now() - t <= HANDOFF_MAX_AGE && !cands.some((c) => c.p === p)) cands.push({ p, t });
    } catch { /* moved or deleted */ }
  };
  for (const e of state.handoffIndex()) add(e.path);
  for (const d of [input.cwd, state.fallbackDir()]) {
    if (!d) continue;
    let items = [];
    try { items = fs.readdirSync(d); } catch { continue; }
    for (const f of items) add(path.join(d, f));
  }
  if (!cands.length) return;
  // Prefer a handoff from the folder this session was opened in; otherwise the newest anywhere.
  const cwd = input.cwd ? path.resolve(input.cwd) : null;
  const here = cands.filter((c) => cwd && path.dirname(c.p).toLowerCase() === cwd.toLowerCase());
  const f = (here.length ? here : cands).sort((a, b) => b.t - a.t)[0].p;
  const goal = goalLine(f);
  state.log({ type: 'handoff-offer', file: f });
  const ctx = `[token-router] 이전 작업 인수인계 파일 ${f}${goal ? ` (목표: ${goal})` : ''}가 있습니다.`
    + ' 사용자가 이어서 하자고 하면(예: "이어서 해줘") 이 파일만 읽고 "미완료·주의"부터 처리한 뒤 "다음 단계"를 진행하고,'
    + ` 다 읽은 뒤 node "${path.join(__dirname, 'handoff.js').replace(/\\/g, '/')}" used "${f}" 를 실행하세요.`
    + ' 다른 요청이면 이 안내는 무시하세요.';
  console.log(JSON.stringify({
    systemMessage: `📄 [token-router] 이전 작업이 있습니다: ${f}${goal ? ` (목표: ${goal})` : ''}\n이어서 하려면 "이어서 해줘"라고 하세요.`,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx },
  }));
}

// Move a picked-up handoff out of the project root so it is not offered again.
function used(name) {
  const n = String(name || '');
  const src = path.isAbsolute(n) ? n
    : (state.handoffIndex().map((x) => x.path).reverse().find((p) => path.basename(p) === path.basename(n)) || path.resolve(n));
  if (!HANDOFF_FILE.test(path.basename(src)) || !fs.existsSync(src)) {
    console.error(`handoff 파일이 없음: ${name}`);
    process.exit(1);
  }
  const done = path.join(path.dirname(src), '.handoff', 'done');
  fs.mkdirSync(done, { recursive: true });
  fs.renameSync(src, path.join(done, path.basename(src)));
  console.log(`정리함: ${path.join(done, path.basename(src))}`);
}

function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'hook') return hook();
  if (cmd === 'guard') return guard();
  if (cmd === 'start') return start();
  if (cmd === 'used') return used(arg);
  if (cmd === '--toast') {
    const st = state.load();
    st.toast = arg !== 'off';
    state.save(st);
    return console.log(`Windows 알림: ${st.toast ? '켜짐' : '꺼짐'}`);
  }
  if (cmd === 'where') {
    const t = arg || latestTranscript();
    const project = t && state.editedProject(t);
    return console.log(project ? `수정한 파일의 프로젝트 → handoff·백업 위치: ${project}` : `수정한 프로젝트 파일 없음 → handoff 위치: ${state.fallbackDir()} (백업 안 함)`);
  }
  if (cmd === '--home') {
    if (!arg) { console.error('usage: node handoff.js --home <폴더>'); process.exit(2); }
    const st = state.load();
    st.handoffHome = path.resolve(arg);
    state.save(st);
    return console.log(`파일 수정 없는 대화의 handoff 위치: ${st.handoffHome}`);
  }
  if (cmd === '--loop') {
    const n = Number(arg);
    if (!(n > 0)) { console.error('usage: node handoff.js --loop <tokens>'); process.exit(2); }
    const st = state.load();
    st.loopTokens = n;
    state.save(st);
    return console.log(`작업 루프 중단 기준: ${n} 토큰`);
  }
  if (cmd === 'name') return console.log(handoffName());
  if (cmd === '--threshold') {
    const n = Number(arg);
    if (!(n > 0)) { console.error('usage: node handoff.js --threshold <tokens>'); process.exit(2); }
    const st = state.load();
    st.handoffTokens = n;
    state.save(st);
    return console.log(`새 세션 권장 기준: ${n} 토큰`);
  }
  if (cmd === 'check') return console.log(JSON.stringify(check(arg || latestTranscript())));
  console.error('usage: node handoff.js check [transcript.jsonl] | hook | guard | start | used <file> | name | --threshold <tokens> | --loop <tokens>');
  process.exit(2);
}

if (require.main === module) main();
module.exports = { measure, lastContext, check, handoffName, latestTranscript, latestHandoff };
