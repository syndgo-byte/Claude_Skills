'use strict';
// Runs the Claude Code CLI bundled with the VS Code extension.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function findClaude(configured) {
  if (configured && fs.existsSync(configured)) return configured;
  const extRoot = path.join(os.homedir(), '.vscode', 'extensions');
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  let dirs = [];
  try {
    dirs = fs.readdirSync(extRoot).filter((d) => d.startsWith('anthropic.claude-code-'));
  } catch { /* no extensions dir */ }
  const candidates = dirs
    .map((d) => path.join(extRoot, d, 'resources', 'native-binary', exe))
    .filter((p) => fs.existsSync(p))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] || 'claude';
}

// Marketplace installs clone with git, so make sure Git for Windows is on PATH.
function buildEnv() {
  const env = { ...process.env };
  if (process.platform === 'win32') {
    const gitDirs = ['C:\\Program Files\\Git\\cmd', 'C:\\Program Files (x86)\\Git\\cmd']
      .filter((d) => fs.existsSync(d));
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path';
    env[key] = [...gitDirs, env[key] || ''].join(';');
  }
  return env;
}

function run(claudePath, args, output) {
  return new Promise((resolve, reject) => {
    output.appendLine(`> claude ${args.join(' ')}`);
    execFile(claudePath, args, { env: buildEnv(), timeout: 300000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (stdout) output.appendLine(stdout.trim());
        if (stderr) output.appendLine(stderr.trim());
        if (err) {
          const lastLine = `${stdout}\n${stderr}`.trim().split(/\r?\n/).filter(Boolean).pop();
          reject(new Error(lastLine || err.message));
        } else {
          resolve(stdout);
        }
      });
  });
}

module.exports = { findClaude, run, buildEnv };
