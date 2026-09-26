#!/usr/bin/env node
'use strict';
// Analyzes recent requests to find when route.js disagrees with actual model usage.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { decide } = require('./route');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const LIMIT = parseInt(process.argv[2]) || 50;

function* readRequestsWithModel() {
  // Scan newest files first. For each file, track the model that answered,
  // and yield each user request right after.
  const dirs = fs.readdirSync(PROJECTS_DIR);
  const files = [];
  for (const d of dirs) {
    const dir = path.join(PROJECTS_DIR, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      files.push({ path: full, mtime: stat.mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  let count = 0;
  for (const { path: file } of files) {
    if (count >= LIMIT) break;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let lastModel = null;
    for (let i = lines.length - 1; i >= 0 && count < LIMIT; i--) {
      if (!lines[i]) continue;
      let e;
      try { e = JSON.parse(lines[i]); } catch { continue; }
      if (e.type === 'assistant' && e.message?.model) {
        lastModel = e.message.model;
      } else if (e.type === 'user' && lastModel && e.message?.content) {
        const prompt = String(e.message.content).trim();
        if (prompt.length > 10 && !prompt.startsWith('/')) {
          yield { prompt, model: lastModel };
          count++;
          lastModel = null;
        }
      }
    }
  }
}

const MODELS = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };
const tier = (m) => {
  for (const [k, v] of Object.entries(MODELS)) {
    if (m.includes(k)) return v;
  }
  return 1;
};

(async () => {
  const results = [];
  let n = 0;
  for (const req of readRequestsWithModel()) {
    const d = await decide(req.prompt);
    const actual = tier(req.model);
    const routed = tier(d.route);
    const diff = routed - actual;
    results.push({ prompt: req.prompt.slice(0, 80), actual: req.model.split('-')[0], routed: d.route, diff, why: d.why });
    n++;
  }

  console.log(`\n분석한 요청: ${n}개\n`);

  const byDiff = {};
  for (const r of results) {
    if (!byDiff[r.diff]) byDiff[r.diff] = [];
    byDiff[r.diff].push(r);
  }

  console.log('📊 분포:');
  console.log(`  ✅ 정확 (0):         ${(byDiff[0] || []).length}`);
  console.log(`  ⬆️  과도라우팅 (+1): ${(byDiff[1] || []).length}`);
  console.log(`  ⬆️⬆️ 과도라우팅 (+2): ${(byDiff[2] || []).length}`);
  console.log(`  ⬇️  저평가라우팅 (-1): ${(byDiff[-1] || []).length}`);
  console.log(`  ⬇️⬇️ 저평가라우팅 (-2): ${(byDiff[-2] || []).length}`);

  if (byDiff[1]?.length || byDiff[2]?.length) {
    console.log('\n⬆️ 과도라우팅 — 신호를 약하게 할 수 있음:');
    const over = [...(byDiff[1] || []), ...(byDiff[2] || [])].slice(0, 8);
    for (const r of over) {
      console.log(`  ${r.actual.padEnd(6)} ← ${r.routed.padEnd(6)} | ${r.prompt.slice(0, 50)}`);
    }
  }

  if (byDiff[-1]?.length || byDiff[-2]?.length) {
    console.log('\n⬇️ 저평가라우팅 — 신호를 강하게 할 수 있음:');
    const under = [...(byDiff[-1] || []), ...(byDiff[-2] || [])].slice(0, 8);
    for (const r of under) {
      console.log(`  ${r.actual.padEnd(6)} ← ${r.routed.padEnd(6)} | ${r.prompt.slice(0, 50)}`);
    }
  }
})();
