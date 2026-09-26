#!/usr/bin/env node
'use strict';
// Auto-detects user dissatisfaction signals and infers actual routing preference.
// Scans conversation for clues like "이건 Haiku로 충분한데", "너무 오버했어", etc.
//
//   node intent-detector.js <jsonl-file>  -> outputs mismatches with confidence
const fs = require('fs');

const DISSATISFACTION_PATTERNS = [
  /이건\s*(haiku|sonnet|opus)(?:\s*(로|만))?(\s*충분|면|지)/i,  // "이건 haiku로 충분해"
  /너무\s*(오버|과도)/i,  // "너무 오버했어"
  /아니\s*이건\s*/(문맥에서 다음 요청이 이전과 다름),
  /왜\s*sonnet으로|왜\s*opus로/i,  // "왜 opus로 갔어"
  /그냥\s*haiku|간단한데|이 정도면/i,  // "그냥 haiku지", "간단한데"
];

function* readAssistantResponses(jsonlFile) {
  const lines = fs.readFileSync(jsonlFile, 'utf8').split('\n');
  let lastModel = null;
  let lastPrompt = null;
  let lastResponse = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    try {
      const e = JSON.parse(lines[i]);
      if (e.type === 'assistant' && e.message?.model) {
        lastModel = e.message.model;
        lastResponse = e.message.content || '';
      } else if (e.type === 'user' && lastModel) {
        lastPrompt = e.message?.content || '';
        yield { prompt: lastPrompt, model: lastModel, response: lastResponse };
        lastModel = null;
        lastResponse = null;
      }
    } catch {}
  }
}

function detectDissatisfaction(text) {
  for (const pattern of DISSATISFACTION_PATTERNS) {
    const m = text.match(pattern);
    if (m) return { found: true, hint: m[0], preferred: m[1] };
  }
  return { found: false };
}

function analyzeResponseComplexity(response) {
  const hasCode = /```|function|class|def |const |function/i.test(response);
  const hasDesign = /설계|아키텍처|구조|트레이드오프/i.test(response);
  const hasBugAnalysis = /원인|디버깅|왜|이유|race condition/i.test(response);
  const length = response.length;

  if (hasCode || hasDesign || hasBugAnalysis) return 'complex';
  if (length > 500) return 'medium';
  return 'simple';
}

const file = process.argv[2];
if (!file) {
  console.error('Usage: node intent-detector.js <jsonl-file>');
  process.exit(1);
}

const results = [];
for (const item of readAssistantResponses(file)) {
  const dissatisfaction = detectDissatisfaction(item.prompt);
  const complexity = analyzeResponseComplexity(item.response);

  if (dissatisfaction.found || complexity !== 'complex') {
    results.push({
      prompt: item.prompt.slice(0, 80),
      model: item.model.split('-')[0],
      complexity,
      dissatisfaction: dissatisfaction.found ? dissatisfaction.hint : null,
      confidence: dissatisfaction.found ? 0.9 : 0.6
    });
  }
}

console.log('🔍 자동 감지된 불일치 (신뢰도 순):');
results.sort((a, b) => b.confidence - a.confidence);
for (const r of results.slice(0, 10)) {
  console.log(`  ${r.model.padEnd(6)} | ${r.complexity.padEnd(7)} | ${r.prompt}`);
  if (r.dissatisfaction) console.log(`         → 불만: "${r.dissatisfaction}"`);
}

console.log(`\n💡 ${results.length}개 잠재적 불일치 발견`);
