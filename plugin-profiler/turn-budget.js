#!/usr/bin/env node
'use strict';
// Real-time circuit breaker, not a report: counts tool calls within the current turn and, past a
// threshold, blocks the next one so Claude sees the warning before doing more — not after a usage
// meter jumps. UserPromptSubmit resets the count; PreToolUse increments and checks it.
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_FILE = path.join(os.homedir(), '.claude', 'token-router', 'turn-budget.json');
const WARN_AT = 12; // nudge, still allowed
const BLOCK_AT = 20; // must justify before continuing

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 1000);
  });
}

function load() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { count: 0 }; }
}

function save(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

async function main() {
  const raw = await readStdin();
  let input = {};
  try { input = JSON.parse(raw); } catch { /* best-effort */ }
  const event = input.hook_event_name;

  if (event === 'UserPromptSubmit') {
    save({ count: 0 });
    return;
  }

  const state = load();
  state.count += 1;
  save(state);

  if (state.count === BLOCK_AT) {
    process.stderr.write(
      `이번 턴에 툴 호출 ${state.count}회째. 지금 하려는 작업이 사용자가 실제로 요청한 것과 직접 관련 있는지,\n`
      + '더 적은 호출로 끝낼 수 있는지 먼저 스스로 점검하고 계속할지 결정할 것. 필요하면 계속해도 됨.\n');
    process.exit(2); // blocks this tool call, feeds stderr back as the reason
  } else if (state.count === WARN_AT) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: `(참고: 이번 턴 툴 호출 ${state.count}회째 — 늘어나는 중)`,
      },
    }));
  }
}

main().catch(() => process.exit(0)); // a broken hook must never block real work
