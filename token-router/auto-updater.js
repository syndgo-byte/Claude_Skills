#!/usr/bin/env node
'use strict';
// Auto-learns from routing mismatches and updates SIGNALS.
// Runs after analyze-history.js finds over/underrouting patterns.
//
//   node auto-updater.js <json-analysis>
// where json-analysis = {1: [{prompt, actual, routed, why},...], -1: [...]}
const fs = require('fs');
const path = require('path');

const ROUTE_FILE = path.join(__dirname, 'route.js');

// Extract words from prompt that might be signals.
function extractWords(prompt) {
  const words = [];
  // Common patterns in Korean/English
  const patterns = [
    /구현(?!된|돼)/g,
    /추가해/g,
    /만들어/g,
    /버그/g,
    /원인/g,
    /왜\s*(이렇|안\s*되)/g,
    /수정/g,
    /고쳐/g,
    /검색/g,
    /찾아/g,
    /읽어/g,
  ];
  for (const p of patterns) {
    const m = prompt.match(p);
    if (m) words.push(...m);
  }
  return [...new Set(words)];
}

// Propose signal updates based on over/underrouting.
function proposedUpdates(overRouted, underRouted) {
  const proposals = [];

  if (overRouted?.length) {
    console.log('⬆️ 과도라우팅 항목들의 신호:');
    const words = {};
    for (const r of overRouted.slice(0, 10)) {
      const w = extractWords(r.prompt);
      for (const word of w) {
        words[word] = (words[word] || 0) + 1;
      }
      console.log(`  "${r.prompt.slice(0, 50)}" (${r.actual}→${r.routed})`);
    }
    console.log('  → 약할 수 있는 신호:', Object.entries(words).filter(([,c]) => c >= 2).map(([w]) => w).join(', '));
  }

  if (underRouted?.length) {
    console.log('\n⬇️ 저평가라우팅 항목들의 신호:');
    const words = {};
    for (const r of underRouted.slice(0, 10)) {
      const w = extractWords(r.prompt);
      for (const word of w) {
        words[word] = (words[word] || 0) + 1;
      }
      console.log(`  "${r.prompt.slice(0, 50)}" (${r.actual}→${r.routed})`);
    }
    console.log('  → 강할 수 있는 신호:', Object.entries(words).filter(([,c]) => c >= 2).map(([w]) => w).join(', '));
  }
}

const input = process.argv[2];
if (!input) {
  console.error('Usage: node auto-updater.js <json-from-analyze-history>');
  process.exit(1);
}

try {
  const analysis = JSON.parse(input);
  const overRouted = analysis[1];
  const underRouted = analysis[-1];
  proposedUpdates(overRouted, underRouted);
  console.log('\n💡 제안사항을 route.js에 수동 적용 후 route.test.js로 검증하세요.');
} catch (e) {
  console.error('JSON 파싱 실패:', e.message);
  process.exit(1);
}
