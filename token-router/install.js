#!/usr/bin/env node
'use strict';
// Installs token-router as a Claude Code skill: copies the files to ~/.claude/skills/token-router
// and registers its hooks in ~/.claude/settings.json. Safe to run again: earlier token-router
// hooks are replaced, not duplicated, and settings.json is backed up before every change.
//
//   node install.js                 -> install or update
//   node install.js --base haiku    -> also set the model new sessions usually start on
//   node install.js --dry-run       -> show the hooks that would be written, change nothing
//   node install.js --uninstall     -> remove the hooks (files stay; delete the folder to remove them)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLAUDE = path.join(os.homedir(), '.claude');
const TARGET = path.join(CLAUDE, 'skills', 'token-router');
const SETTINGS = path.join(CLAUDE, 'settings.json');
const FILES = ['SKILL.md', 'README.md', 'install.js', 'route.js', 'handoff.js', 'context-monitor.js', 'journal.js', 'snapshot.js', 'state.js'];

// Forward slashes work in both cmd and Git Bash, which is what hooks run under on Windows.
const cmd = (script, sub = 'hook') => `node "${path.join(TARGET, script).replace(/\\/g, '/')}" ${sub}`;
const HOOKS = {
  UserPromptSubmit: [cmd('route.js'), cmd('handoff.js')],
  Stop: [cmd('journal.js')],
  PreCompact: [cmd('journal.js')],
  SessionEnd: [cmd('journal.js')],
  PostToolUse: [cmd('handoff.js', 'guard')],
  SessionStart: [cmd('handoff.js', 'start')],
};
const MATCHERS = { PostToolUse: '*' }; // tool events need a matcher; '*' = every tool
const ours = (h) => typeof h.command === 'string' && /token-router[\\/][a-z]+\.js"?\s+(hook|guard|start)\b/.test(h.command);

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  const text = fs.readFileSync(SETTINGS, 'utf8');
  try { return text.trim() ? JSON.parse(text) : {}; } catch (e) {
    console.error(`settings.json을 읽지 못해 중단합니다 (${e.message}). 파일을 고친 뒤 다시 실행하세요.`);
    process.exit(1);
  }
}

// Drop every earlier token-router hook, then add the current set once per event.
function mergeHooks(settings, install) {
  const hooks = { ...(settings.hooks || {}) };
  for (const event of Object.keys(hooks)) {
    const groups = (hooks[event] || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(h)) }))
      .filter((g) => g.hooks.length);
    if (groups.length) hooks[event] = groups; else delete hooks[event];
  }
  if (install) {
    for (const [event, commands] of Object.entries(HOOKS)) {
      const group = { hooks: commands.map((c) => ({ type: 'command', command: c })) };
      if (MATCHERS[event]) group.matcher = MATCHERS[event];
      hooks[event] = [...(hooks[event] || []), group];
    }
  }
  const out = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete out.hooks;
  return out;
}

function writeSettings(next) {
  fs.mkdirSync(CLAUDE, { recursive: true });
  if (fs.existsSync(SETTINGS)) {
    const stamp = new Date().toISOString().replace(/[-:.Z]/g, '');
    fs.copyFileSync(SETTINGS, `${SETTINGS}.bak-${stamp}`);
  }
  fs.writeFileSync(SETTINGS, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

function copyFiles() {
  const src = path.resolve(__dirname);
  if (src === path.resolve(TARGET)) return '이미 스킬 폴더에서 실행 중이라 복사 생략';
  fs.mkdirSync(TARGET, { recursive: true });
  const missing = FILES.filter((f) => !fs.existsSync(path.join(src, f)));
  if (missing.length) { console.error(`파일이 없습니다: ${missing.join(', ')}`); process.exit(1); }
  for (const f of FILES) fs.copyFileSync(path.join(src, f), path.join(TARGET, f));
  return `${FILES.length}개 파일 복사 → ${TARGET}`;
}

function main() {
  const args = process.argv.slice(2);
  const uninstall = args.includes('--uninstall');
  const dry = args.includes('--dry-run');
  const base = args[args.indexOf('--base') + 1];
  const next = mergeHooks(readSettings(), !uninstall);

  if (dry) return console.log(JSON.stringify(next.hooks || {}, null, 2));
  if (uninstall) {
    writeSettings(next);
    return console.log(`token-router 훅 제거 완료 (${SETTINGS}, 백업 있음). 파일은 ${TARGET}에 남아 있습니다.`);
  }

  console.log(copyFiles());
  writeSettings(next);
  console.log(`훅 등록 완료 → ${SETTINGS} (기존 파일은 .bak-* 로 백업)`);
  const run = (script, ...a) => execFileSync(process.execPath, [path.join(TARGET, script), ...a], { encoding: 'utf8' }).trim();
  if (args.includes('--base') && base) console.log(run('route.js', '--base', base));
  console.log(`자가 점검: ${run('route.js', '엑셀 읽어서 합계 스크립트 만들어줘')}`);
  console.log('\n끝. Claude Code를 다시 시작하면 훅이 적용됩니다.'
    + '\n프로젝트마다 .gitignore 에 .handoff/ 를 추가하세요 (일지에 요청 원문과 명령이 남습니다).');
}

main();
