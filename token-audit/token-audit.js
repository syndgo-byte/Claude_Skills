#!/usr/bin/env node
'use strict';
// Finds what used up Claude Code tokens, from the local transcripts in ~/.claude/projects.
// Nothing is sent anywhere and no model is called.
//
//   node token-audit.js               -> report for the last 14 days
//   node token-audit.js --days 30
//
// Two kinds of numbers:
//   exact     - the usage the API reported for each answer (input + cache + output tokens)
//   estimated - how much each kind of content added to the context. Anything that enters the
//               context is re-read by every later call in that session, so an item's weight is
//               its size x the number of calls after it. A hook that injects 500 tokens on every
//               prompt therefore costs far more than a one-off 5k file read early in a short session.
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const DAYS = Number(args[args.indexOf('--days') + 1]) || 14;
const ROOT = path.join(os.homedir(), '.claude', 'projects');

// Rough token estimate: Korean runs about 1 token per 1-2 characters, English about 4 characters.
const estTokens = (text) => {
  const s = String(text || '');
  const hangul = (s.match(/[가-힣]/g) || []).length;
  return Math.round(hangul / 1.5 + (s.length - hangul) / 3.5);
};
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

function transcripts(dir, since, out = []) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) transcripts(full, since, out);
    else if (it.name.endsWith('.jsonl') && fs.statSync(full).mtimeMs >= since) out.push(full);
  }
  return out;
}

const textOf = (c) => (typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((b) => b.text || b.content && textOf(b.content) || '').join('\n') : '');

function textLabel(t) {
  if (/^Base directory for this skill/.test(t)) return '스킬 본문 로드';
  if (/^\s*<(user-prompt-submit-hook|[a-z-]*hook[a-z-]*)>/i.test(t)) return '훅 출력';
  if (/^\s*<system-reminder>/.test(t)) return '시스템 알림';
  return '사용자 질문';
}

// Label for each piece of content that entered the context.
function pieces(e, toolNames) {
  const out = [];
  if (e.type === 'attachment' && e.attachment) {
    const rendered = (e.rendered || []).map((r) => textOf(r.content)).join('\n');
    const type = e.attachment.type || 'unknown';
    const label = /hook/i.test(type) ? `훅: ${type}` : type === 'skill_listing' ? '스킬 목록' : `첨부: ${type}`;
    if (rendered) out.push([label, rendered]);
  } else if (e.type === 'system' && Array.isArray(e.hookAdditionalContext) && e.hookAdditionalContext.length) {
    out.push([`훅 출력: ${e.subtype || 'system'}`, e.hookAdditionalContext.join('\n')]);
  } else if (e.type === 'user' && e.message) {
    const c = e.message.content;
    if (typeof c === 'string') out.push([/<(command|local-command)/.test(c) ? '명령 출력' : textLabel(c), c]);
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'tool_result') out.push([`도구 결과: ${toolNames.get(b.tool_use_id) || '?'}`, textOf(b.content)]);
        else if (b.type === 'text') out.push([textLabel(b.text), b.text]);
        else if (b.type === 'image') out.push(['이미지', 'x'.repeat(5000)]); // ~1.5k tokens, rough
      }
    }
  } else if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
    for (const b of e.message.content) {
      if (b.type === 'text') out.push(['Claude 답변', b.text]);
      if (b.type === 'tool_use') out.push([`도구 호출: ${b.name}`, JSON.stringify(b.input || {})]);
    }
  }
  return out;
}

function analyze(file) {
  const entries = [];
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l) continue;
    try { entries.push(JSON.parse(l)); } catch { /* skip broken line */ }
  }
  const toolNames = new Map();
  for (const e of entries) {
    for (const b of (e.message && Array.isArray(e.message.content) ? e.message.content : [])) {
      if (b.type === 'tool_use') toolNames.set(b.id, b.name);
    }
  }
  // One API call per assistant message id; its usage is exact.
  const calls = [];
  const seen = new Set();
  entries.forEach((e, i) => {
    const m = e.message;
    if (e.type !== 'assistant' || !m || !m.usage || seen.has(m.id)) return;
    seen.add(m.id);
    const u = m.usage;
    calls.push({ i, model: m.model || '?', input: u.input_tokens || 0, write: u.cache_creation_input_tokens || 0,
      read: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 });
  });
  const callsAfter = (i) => { let n = 0; for (const c of calls) if (c.i > i) n += 1; return n; };
  const weight = new Map();
  let beforeFirst = 0;
  entries.forEach((e, i) => {
    const after = callsAfter(i);
    for (const [label, text] of pieces(e, toolNames)) {
      const t = estTokens(text);
      const w = weight.get(label) || { size: 0, reread: 0, count: 0 };
      w.size += t; w.reread += t * after; w.count += 1;
      weight.set(label, w);
      if (calls[0] && i < calls[0].i) beforeFirst += t;
    }
  });
  const first = calls[0];
  const ctx = (c) => c.input + c.write + c.read;
  // The system prompt and tool/MCP definitions are not in the transcript. Back them out of the
  // first call's exact context size; they are resent with every call.
  if (first) {
    const fixed = Math.max(0, ctx(first) - beforeFirst);
    weight.set('시스템 프롬프트·도구·MCP 정의 (역산)', { size: fixed, reread: fixed * calls.length, count: 1 });
  }
  return {
    file, calls, weight,
    date: (entries.find((e) => e.timestamp) || {}).timestamp || '',
    baseline: first ? ctx(first) : 0,
    peak: calls.reduce((m, c) => Math.max(m, ctx(c)), 0),
    turns: entries.filter((e) => e.type === 'user' && typeof (e.message || {}).content === 'string').length,
  };
}

function main() {
  const files = transcripts(ROOT, Date.now() - DAYS * 86400000);
  if (!files.length) return console.log(`최근 ${DAYS}일 대화 기록이 없습니다 (${ROOT}).`);
  const sessions = files.map(analyze).filter((s) => s.calls.length);

  const byModel = {};
  const all = new Map();
  for (const s of sessions) {
    for (const c of s.calls) {
      const m = byModel[c.model] || (byModel[c.model] = { calls: 0, input: 0, write: 0, read: 0, output: 0 });
      m.calls += 1; m.input += c.input; m.write += c.write; m.read += c.read; m.output += c.output;
    }
    for (const [label, w] of s.weight) {
      const a = all.get(label) || { size: 0, reread: 0, count: 0 };
      a.size += w.size; a.reread += w.reread; a.count += w.count;
      all.set(label, a);
    }
  }

  const out = [`# 토큰 사용 분석 (최근 ${DAYS}일, 세션 ${sessions.length}개)`, ''];
  out.push('## 1. 모델별 실제 사용량 (정확)', '',
    '| 모델 | API 호출 | 새 입력 | 캐시 쓰기 | 캐시 읽기 | 출력 |', '|---|---|---|---|---|---|');
  for (const [m, v] of Object.entries(byModel).sort((a, b) => (b[1].read + b[1].write) - (a[1].read + a[1].write))) {
    out.push(`| ${m} | ${v.calls} | ${k(v.input)} | ${k(v.write)} | ${k(v.read)} | ${k(v.output)} |`);
  }

  const total = [...all.values()].reduce((a, w) => a + w.reread, 0) || 1;
  out.push('', '## 2. 무엇이 맥락을 채웠나 (추정)', '',
    '재읽기 = 크기 × 그 뒤 호출 수. 매 턴 들어가는 훅·알림은 여기서 크게 잡힙니다.', '',
    '| 항목 | 횟수 | 크기 합 | 재읽기 누적 | 비중 |', '|---|---|---|---|---|');
  for (const [label, w] of [...all].sort((a, b) => b[1].reread - a[1].reread).slice(0, 20)) {
    out.push(`| ${label} | ${w.count} | ${k(w.size)} | ${k(w.reread)} | ${(100 * w.reread / total).toFixed(1)}% |`);
  }

  out.push('', '## 3. 가장 많이 쓴 세션 (정확)', '',
    '시작 맥락 = 첫 답변 때 이미 들어 있던 양(시스템 프롬프트·도구·MCP·스킬 목록·CLAUDE.md·메모리). 이 값이 어느 날부터 커졌다면 그때 설치한 것이 범인입니다.', '',
    '| 날짜 | 세션 | 턴 | 호출 | 시작 맥락 | 최대 맥락 | 입력 합(캐시 포함) | 출력 합 |', '|---|---|---|---|---|---|---|---|');
  const sum = (s, f) => s.calls.reduce((a, c) => a + f(c), 0);
  const heavy = sessions.map((s) => ({ s, in: sum(s, (c) => c.input + c.write + c.read), outT: sum(s, (c) => c.output) }))
    .sort((a, b) => b.in - a.in).slice(0, 10);
  for (const { s, in: inT, outT } of heavy) {
    out.push(`| ${s.date.slice(0, 10)} | ${path.basename(s.file, '.jsonl').slice(0, 8)} | ${s.turns} | ${s.calls.length} | ${k(s.baseline)} | ${k(s.peak)} | ${k(inT)} | ${k(outT)} |`);
  }

  out.push('', '## 4. 날짜별 시작 맥락 (중앙값)', '', '| 날짜 | 세션 | 시작 맥락 |', '|---|---|---|');
  const byDay = {};
  for (const s of sessions) (byDay[s.date.slice(0, 10)] = byDay[s.date.slice(0, 10)] || []).push(s.baseline);
  for (const [d, v] of Object.entries(byDay).sort()) {
    const sorted = v.sort((a, b) => a - b);
    out.push(`| ${d} | ${v.length} | ${k(sorted[Math.floor(sorted.length / 2)])} |`);
  }

  const report = out.join('\n') + '\n';
  const dest = path.join(process.cwd(), `token-audit-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(dest, report, 'utf8');
  console.log(report);
  console.log(`저장: ${dest}`);
}

main();
