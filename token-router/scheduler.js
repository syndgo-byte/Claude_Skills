#!/usr/bin/env node
'use strict';
// Runs after handoff/compact: auto-analyzes recent requests and proposes signal updates.
// Intended to run via SessionStart hook (not blocking).
//
//   node scheduler.js [limit=50]
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

const LIMIT = process.argv[2] || 50;
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Run analyze-history and capture results.
function analyze() {
  try {
    const script = path.join(__dirname, 'analyze-history.js');
    const output = execSync(`node "${script}" ${LIMIT}`, { encoding: 'utf8' });
    return output;
  } catch (e) {
    console.error('❌ 분석 실패:', e.message);
    return null;
  }
}

// Parse analyze output into structured data.
function parseAnalysis(output) {
  const lines = output.split('\n');
  const result = { 1: [], '-1': [] };
  let currentDiff = null;

  for (const line of lines) {
    if (line.includes('과도라우팅')) currentDiff = 1;
    else if (line.includes('저평가라우팅')) currentDiff = -1;
    else if (line.startsWith('  ') && currentDiff && line.includes('←')) {
      const parts = line.split('|');
      if (parts.length >= 2) {
        const [actual, routed] = parts[0].trim().split('←').map(s => s.trim());
        result[currentDiff].push({
          prompt: parts[1]?.trim() || '',
          actual, routed
        });
      }
    }
  }
  return result;
}

// Main loop.
console.log('🔍 자동 분석 시작...');
const output = analyze();
if (!output) process.exit(1);

console.log(output);

const analysis = parseAnalysis(output);
if ((analysis[1]?.length || 0) + (analysis[-1]?.length || 0) > 0) {
  console.log('\n💾 분석 결과를 auto-updater에 전달...');
  try {
    const script = path.join(__dirname, 'auto-updater.js');
    execSync(`node "${script}" '${JSON.stringify(analysis).replace(/'/g, "'\\''")}'`, { stdio: 'inherit' });
  } catch (e) {
    console.error('⚠️ 업데이터 실패:', e.message);
  }
} else {
  console.log('✅ 라우팅이 이미 최적화됨');
}
