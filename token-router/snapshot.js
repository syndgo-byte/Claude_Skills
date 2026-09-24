#!/usr/bin/env node
'use strict';
// Snapshot before a handoff: gzips the project files that changed since the last snapshot into
// <project>/backup-claude/<date-time>/<path>.gz, so a bad edit in the next session can be undone.
// No git needed.
//
// Backups are stored compressed on purpose: with a .gz name and gzip content, scripts that scan
// the project for *.xlsx, *.py and so on never pick up a backup copy, and nothing reads them by
// accident. Restoring goes through --restore.
//
// Each project's backup-claude folder is kept under a size cap (default 5GB). Past the cap, older
// versions are deleted first, but never the newest copy of a file.
//
//   node snapshot.js [projectDir]                    -> back up changed files (default: current folder)
//   node snapshot.js --list [projectDir]             -> snapshots of this project
//   node snapshot.js --restore <stamp|latest> [file] [--project <dir>]
//                                                    -> put files back as they were at that snapshot
//   node snapshot.js --limits <maxGB> <fileMB>       -> cap per project and per-file limit (default 5 200)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const state = require('./state');

const DEFAULT = { maxGB: 5, fileMB: 200 };
const BACKUP = 'backup-claude';
const STAMP = /^\d{8}-\d{6}$/;
// Folders that are rebuilt, huge, or not the user's work.
const SKIP_DIRS = new Set([BACKUP, '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next',
  '.cache', '.handoff', '.idea', '.vs', 'target', 'bin', 'obj']);
// Secrets are not copied around: a backup folder is one more place for them to leak from.
const SKIP_FILES = [/(^|\/)\.env(\..*)?$/i, /\.(pem|key|p12|pfx|keystore|jks)$/i, /(^|\/)id_(rsa|ed25519|ecdsa)[^/]*$/i,
  /(^|\/)(credentials|secrets?)(\.[a-z]+)?$/i, /~\$/, /\.(tmp|log)$/i];

const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;
const gb = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(2)}GB` : mb(n));
const config = () => ({ ...DEFAULT, ...(state.load().snapshot || {}) });

// ripgrep (Claude Code's Grep/Glob) honours .ignore, git honours .gitignore; '*' hides the folder.
function prepareBackupDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['.ignore', '.gitignore']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) fs.writeFileSync(p, '*\n', 'utf8');
  }
  const readme = path.join(dir, 'README.txt');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, 'token-router 백업 폴더입니다. 파일은 압축(.gz)되어 있습니다.\n'
      + '되돌리기: node <스킬폴더>/snapshot.js --restore <날짜-시각|latest> [파일경로]\n'
      + '이 폴더는 지워도 프로젝트에는 영향이 없습니다.\n', 'utf8');
  }
}

function walk(root, skipUnder, visit) {
  const go = (d) => {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) {
        if (!SKIP_DIRS.has(it.name) && path.resolve(full) !== skipUnder) go(full);
      } else if (it.isFile()) visit(full);
    }
  };
  go(root);
}

const snapshots = (dir) => { try { return fs.readdirSync(dir).filter((x) => STAMP.test(x)).sort(); } catch { return []; } };

// Every stored version: { snap, rel (original path, no .gz), full, size }, oldest snapshot first.
function storedVersions(dir) {
  const out = [];
  for (const snap of snapshots(dir)) {
    const sdir = path.join(dir, snap);
    walk(sdir, null, (full) => {
      if (full.endsWith('.gz')) out.push({ snap, rel: path.relative(sdir, full).slice(0, -3), full, size: fs.statSync(full).size });
    });
  }
  return out;
}

// Delete old versions until the folder fits the cap; the newest copy of each file always stays.
function prune(dir, capBytes) {
  const versions = storedVersions(dir);
  let total = versions.reduce((a, v) => a + v.size, 0);
  const newest = new Map();
  for (const v of versions) newest.set(v.rel, v.snap);
  let removed = 0;
  for (const v of versions) {
    if (total <= capBytes) break;
    if (newest.get(v.rel) === v.snap) continue;
    try { fs.unlinkSync(v.full); total -= v.size; removed += 1; } catch { /* already gone */ }
  }
  const clean = (d) => {
    for (const it of fs.readdirSync(d)) { const p = path.join(d, it); if (fs.statSync(p).isDirectory()) clean(p); }
    if (d !== dir && !fs.readdirSync(d).length) fs.rmdirSync(d);
  };
  clean(dir);
  return { total, removed };
}

async function snapshot(projectDir, only = null) {
  const c = config();
  const cap = c.maxGB * 1073741824;
  const project = path.resolve(projectDir);
  const pdir = path.join(project, BACKUP);
  const marker = path.join(pdir, '.last');
  let since = 0;
  try { since = Number(fs.readFileSync(marker, 'utf8')) || 0; } catch { /* first snapshot: everything */ }

  const take = [];
  const skipped = [];
  let bytes = 0;
  walk(project, pdir, (full) => {
    const rel = path.relative(project, full);
    const norm = rel.replace(/\\/g, '/');
    if (only && !only.has(norm)) return;
    let st;
    try { st = fs.statSync(full); } catch { return; }
    if (!only && st.mtimeMs <= since) return;
    if (SKIP_FILES.some((re) => re.test(norm))) { skipped.push(`${rel} (민감·임시 파일)`); return; }
    if (st.size > c.fileMB * 1048576) { skipped.push(`${rel} (${mb(st.size)} > 파일 한도 ${c.fileMB}MB)`); return; }
    take.push({ full, rel });
    bytes += st.size;
  });
  if (bytes > cap) {
    return { ok: false, lines: [`바뀐 파일이 ${gb(bytes)}로 한도 ${gb(cap)}보다 커서 백업하지 않음. 큰 파일을 제외하거나 한도를 조정할 것.`] };
  }

  const started = Date.now();
  prepareBackupDir(pdir);
  const lines = [];
  if (take.length) {
    const d = new Date(started);
    const p = (n) => String(n).padStart(2, '0');
    let name = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    // Two backups in the same second (restore right after a snapshot): wait for the next second.
    while (fs.existsSync(path.join(pdir, name))) {
      await new Promise((ok) => setTimeout(ok, 1000 - (Date.now() % 1000) + 5));
      const n = new Date();
      name = `${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}`;
    }
    const sdir = path.join(pdir, name);
    let stored = 0;
    for (const f of take) {
      const dest = path.join(sdir, `${f.rel}.gz`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await pipeline(fs.createReadStream(f.full), zlib.createGzip(), fs.createWriteStream(dest));
      stored += fs.statSync(dest).size;
    }
    lines.push(`백업 ${path.join(BACKUP, name)} (파일 ${take.length}개, 원본 ${mb(bytes)} → 압축 ${mb(stored)})`);
  } else {
    lines.push('지난 백업 이후 바뀐 파일 없음.');
  }
  if (!only) fs.writeFileSync(marker, String(started), 'utf8');

  const { total, removed } = prune(pdir, cap);
  if (removed) lines.push(`한도 ${gb(cap)} 유지를 위해 오래된 버전 ${removed}개 삭제.`);
  lines.push(`${BACKUP} 사용량 ${gb(total)} / ${gb(cap)}`);
  if (total > cap) lines.push('경고: 파일마다 최신 사본만 남겨도 한도를 넘음. 한도를 올리거나 backup-claude를 정리할 것.');
  lines.push(...skipped.map((s) => `제외: ${s}`));
  state.log({ type: 'snapshot', files: take.length, bytes, removed, total });
  return { ok: true, lines };
}

// Put files back as they were at `stamp`: for each file, the newest stored version at or before it.
// The current state of those files is backed up first, so a restore can itself be undone.
async function restore(projectDir, stamp, file) {
  const project = path.resolve(projectDir);
  const pdir = path.join(project, BACKUP);
  const snaps = snapshots(pdir);
  if (!snaps.length) return { ok: false, lines: [`백업 없음 (${pdir})`] };
  const upto = stamp === 'latest' ? snaps[snaps.length - 1] : stamp;
  if (!STAMP.test(upto) || upto < snaps[0]) return { ok: false, lines: [`해당 시점 백업 없음: ${stamp}. --list로 확인할 것.`] };
  const want = file && path.normalize(file);
  const pick = new Map();
  for (const v of storedVersions(pdir)) {
    if (v.snap <= upto && (!want || path.normalize(v.rel) === want)) pick.set(v.rel, v);
  }
  if (!pick.size) return { ok: false, lines: [`${upto} 이전 백업에 ${file || '파일'}이(가) 없음.`] };

  const before = await snapshot(project, new Set([...pick.keys()].map((r) => r.replace(/\\/g, '/'))));
  for (const [rel, v] of pick) {
    const dest = path.join(project, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await pipeline(fs.createReadStream(v.full), zlib.createGunzip(), fs.createWriteStream(dest));
  }
  state.log({ type: 'restore', files: pick.size, upto });
  return {
    ok: true,
    lines: [`${upto} 시점으로 파일 ${pick.size}개 복원.`, ...[...pick.keys()].slice(0, 20).map((r) => `  ${r}`),
      `복원 전 상태는 먼저 백업함: ${before.lines[0]}`],
  };
}

function list(projectDir) {
  const pdir = path.join(path.resolve(projectDir), BACKUP);
  const snaps = snapshots(pdir);
  if (!snaps.length) return `백업 없음 (${pdir})`;
  return [pdir, ...snaps.map((s) => {
    let n = 0; let size = 0;
    walk(path.join(pdir, s), null, (f) => { n += 1; size += fs.statSync(f).size; });
    return `  ${s}  파일 ${n}개  ${mb(size)}`;
  })].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
  if (args[0] === '--limits') {
    const [maxGB, fileMB] = args.slice(1).map(Number);
    if (!(maxGB > 0 && fileMB > 0)) { console.error('usage: node snapshot.js --limits <maxGB> <fileMB>'); process.exit(2); }
    const st = state.load();
    st.snapshot = { ...(st.snapshot || {}), maxGB, fileMB };
    state.save(st);
    return console.log(`백업 한도: 프로젝트당 ${maxGB}GB · 파일 ${fileMB}MB`);
  }
  if (args[0] === '--list') return console.log(list(args[1] || process.cwd()));
  let r;
  try {
    if (args[0] === '--restore') {
      const project = opt('--project') || process.cwd();
      if (!args[1]) { console.error('usage: node snapshot.js --restore <날짜-시각|latest> [파일] [--project <폴더>]'); process.exit(2); }
      r = await restore(project, args[1], args[2]);
    } else {
      r = await snapshot(args[0] || process.cwd());
    }
  } catch (e) {
    r = { ok: false, lines: [`실패: ${e.message}`] };
  }
  console.log(r.lines.join('\n'));
  process.exit(r.ok ? 0 : 1);
}

if (require.main === module) main();
module.exports = { snapshot, restore, prune };
