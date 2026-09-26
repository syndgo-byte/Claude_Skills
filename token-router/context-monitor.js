#!/usr/bin/env node
'use strict';
// 현재 맥락 크기를 측정하고 ~/.claude/context-monitor.json에 저장.
// 모든 훅(UserPromptSubmit, PostToolUse)에서 실행되어 상태 표시줄에 표시됨.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const MONITOR_FILE = path.join(os.homedir(), '.claude', 'context-monitor.json');
const CACHE_FILE = path.join(os.homedir(), '.claude', 'context-monitor-cache.json');
const SKILL_DIR = __dirname;
const CACHE_TTL = 2000; // 2초 캐시

// Same limits handoff.js acts on (warning / forced handoff), so the display never disagrees with it.
const st = require('./state').load();
const THRESHOLD = st.handoffTokens || 80000;
const LOOP_THRESHOLD = st.loopTokens || 200000;

function getCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (Date.now() - cache.timestamp > CACHE_TTL) return null;
    return cache.data;
  } catch { return null; }
}

function setCache(data) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ timestamp: Date.now(), data }, null, 0));
  } catch {}
}

function getLatestTranscript() {
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
      try {
        const t = fs.statSync(full).mtimeMs;
        if (!best || t > best.t) best = { full, t };
      } catch {}
    }
  }
  return best && best.full;
}

function measure() {
  const file = getLatestTranscript();
  if (!file) return null;

  let lines = [];
  try {
    const content = fs.readFileSync(file, 'utf8');
    const allLines = content.split('\n');
    // 마지막 500라인만 읽기 (최근 메시지 충분함)
    lines = allLines.slice(Math.max(0, allLines.length - 500));
  } catch { return null; }

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

  return { context, turns, model, file };
}

function formatSize(bytes) {
  if (bytes > 1000000) return (bytes / 1000000).toFixed(1) + 'M';
  if (bytes > 1000) return (bytes / 1000).toFixed(1) + 'k';
  return bytes + 'b';
}

function getEmoji(context, threshold, loop) {
  if (context >= loop) return '🔴'; // 빨간색: 200k+
  if (context >= threshold) return '🟠'; // 주황색: 80k+
  if (context >= threshold * 0.875) return '🟡'; // 노란색: 70k+
  return '🟢'; // 초록색: 정상
}

function main() {
  // 캐시 확인 (--no-cache 플래그로 건너뛸 수 있음)
  if (!process.argv.includes('--no-cache')) {
    const cached = getCache();
    if (cached) {
      outputResult(cached);
      return;
    }
  }

  const data = measure();
  if (!data) return;

  const emoji = getEmoji(data.context, THRESHOLD, LOOP_THRESHOLD);
  const thresholdPercent = Math.round((data.context / THRESHOLD) * 100);
  const loopThresholdPercent = Math.round((data.context / LOOP_THRESHOLD) * 100);

  const status = {
    timestamp: new Date().toISOString(),
    context: data.context,
    contextFormatted: formatSize(data.context),
    turns: data.turns,
    model: data.model,
    emoji,
    atThreshold: data.context >= THRESHOLD,
    atLoopThreshold: data.context >= LOOP_THRESHOLD,
    thresholdPercent,
    loopThresholdPercent,
    recommendation: data.context >= LOOP_THRESHOLD ? 'STOP_LOOP' : (data.context >= THRESHOLD ? 'NEW_SESSION' : 'CONTINUE'),
  };

  fs.mkdirSync(path.dirname(MONITOR_FILE), { recursive: true });
  fs.writeFileSync(MONITOR_FILE, JSON.stringify(status, null, 2) + '\n');
  setCache(status);

  outputResult(status);
}

function outputResult(status) {
  const { emoji, context, thresholdPercent, loopThresholdPercent } = status;

  // 터미널에 큰 색상 배너 표시 (--terminal 플래그)
  if (process.argv.includes('--terminal')) {
    const width = 60;
    const msg = `${emoji} 맥락: ${context}토큰 (${thresholdPercent}% / ${loopThresholdPercent}%)`;
    const padding = Math.max(0, Math.floor((width - msg.length) / 2));
    console.log('\n' + '═'.repeat(width));
    console.log(' '.repeat(padding) + msg);
    console.log('═'.repeat(width) + '\n');
  } else if (process.argv.includes('--verbose')) {
    console.log(JSON.stringify(status, null, 2));
  }
}

main();
