#!/usr/bin/env node
'use strict';
// Analyzes answer complexity to infer if routing was appropriate.
// If answer is short/simple but used expensive model, that's a signal.
//
//   node outcome-analyzer.js <jsonl-file>
const fs = require('fs');

function* readResponses(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let lastModel = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    try {
      const e = JSON.parse(lines[i]);
      if (e.type === 'assistant' && e.message?.model) {
        lastModel = e.message.model;
      } else if (e.type === 'user' && lastModel) {
        const response = e.message?.content || '';
        yield { model: lastModel, prompt: e.message?.content?.slice?.(0, 80) || '', response };
        lastModel = null;
      }
    } catch {}
  }
}

function scoreComplexity(response) {
  let score = 0;

  // Code presence (10 points)
  if (/```|const |function |class |def |import |export/i.test(response)) score += 10;

  // Architecture/design (8 points)
  if (/설계|아키텍처|구조|트레이드오프|다이어그램|flow/i.test(response)) score += 8;

  // Bug analysis (8 points)
  if (/원인|디버깅|왜|로그|stack trace|breakpoint/i.test(response)) score += 8;

  // Length (points for being short = opposite signal)
  if (response.length < 100) score -= 3;
  if (response.length > 1000) score += 2;

  return Math.max(0, score);
}

function expectedComplexity(model) {
  const tiers = { haiku: 2, sonnet: 5, opus: 8, fable: 10 };
  return tiers[model.split('-')[0]] || 5;
}

const file = process.argv[2];
if (!file) {
  console.error('Usage: node outcome-analyzer.js <jsonl-file>');
  process.exit(1);
}

const mismatches = [];
for (const item of readResponses(file)) {
  const actual = scoreComplexity(item.response);
  const expected = expectedComplexity(item.model);
  const diff = expected - actual;

  if (diff > 3) {  // Model was too expensive
    mismatches.push({
      model: item.model.split('-')[0],
      actualComplexity: actual,
      expectedComplexity: expected,
      prompt: item.prompt,
      overrouted: true
    });
  }
}

console.log('📊 모델별 과도라우팅 (답변이 간단했음):');
mismatches.slice(0, 15).forEach(m => {
  console.log(`  ${m.model.padEnd(6)} | 실제${m.actualComplexity} vs 기대${m.expectedComplexity} | ${m.prompt}`);
});

console.log(`\n💡 ${mismatches.length}개 과도라우팅 발견`);
