#!/usr/bin/env node
'use strict';
// SessionStart hook entry point: reads hook JSON from stdin (Claude Code passes {cwd, ...}),
// decides a plugin profile for that project with profile.js, and writes it to settings.json.
// Runs at the very start of a session, before the skill/command listing is built for that
// session — this is the one point where an enable/disable change can affect the session that
// is about to start, unlike mid-session changes which only take effect next time.
const { decide, applyDecision } = require('./profile');

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
  const raw = await readStdin();
  let cwd = process.cwd();
  try {
    const input = JSON.parse(raw);
    if (input.cwd) cwd = input.cwd;
  } catch { /* fall back to process.cwd() */ }

  const dryRun = process.argv.includes('--dry-run');
  const { enabled, reasons } = await decide(cwd);
  const changes = applyDecision(cwd, enabled, reasons, dryRun);
  if (process.argv.includes('--verbose') || dryRun) {
    console.log(JSON.stringify({ cwd, changes, reasons }, null, 2));
  }
}

main().catch((e) => {
  // A hook that throws must not break session start; log and exit clean.
  try { require('fs').appendFileSync(require('path').join(__dirname, 'decisions.log'), `[error] ${e.stack}\n`); } catch {}
  process.exit(0);
});
