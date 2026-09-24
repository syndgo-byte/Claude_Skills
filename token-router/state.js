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

module.exports = { load, save, log, stats, DIR };
