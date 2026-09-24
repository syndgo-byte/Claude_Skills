#!/usr/bin/env node
'use strict';
// Picks the cheapest Claude model that can do a task. Costs no Claude tokens:
// local rules decide first, and only unclear cases go to a free external classifier (no API key).
//
//   node route.js "<task>"          -> one-line JSON {"route", "by", "why"}
//   node route.js --stats           -> routing counts
//   node route.js --on | --off      -> routing on / off
//   node route.js --llm on|off      -> free AI classifier for unclear cases
//   node route.js --fable on|off    -> allow routing to Fable (uses extra usage credits)
const https = require('https');
const state = require('./state');

const ROUTES = ['haiku', 'sonnet', 'opus', 'fable'];

// Each signal adds weight to a route. Korean and English phrasings both count.
const SIGNALS = {
  haiku: [
    [/어디(에|서)?\s*(있|정의|쓰)|찾아|검색|목록|나열|몇\s*개|확인만|읽어|요약|번역|분류|설명해|뭐야|알려줘/, 3],
    [/\b(where is|find|search|grep|list|locate|count|summari[sz]e|translate|classify|explain|what does|look up|read)\b/i, 3],
    [/이름\s*바꿔|리네임|rename|포맷|format|오타|typo|주석\s*달/i, 2],
  ],
  sonnet: [
    [/구현|추가해|만들어|고쳐|수정|버그|기능|엔드포인트|컴포넌트|화면|테스트|타입\s*힌트|일괄|변환|리팩터|정리해|개선|최적화|배포/, 2],
    [/\b(implement|add|build|fix|bug|feature|endpoint|component|update|tests?|type hints?|convert|bulk|refactor|clean ?up|improve|optimi[sz]e|deploy)\b/i, 2],
  ],
  opus: [
    [/설계|아키텍처|구조를?\s*(어떻게|잡)|왜\s*(이렇|안\s*되|느려)|원인|근본|트레이드오프|결정|어떤\s*방식|어떻게\s*가져갈|고민|전략|계획\s*세워|보안|취약/, 4],
    [/\b(design|architecture|why (does|is)|root cause|trade-?offs?|decide|which approach|strategy|plan|security|vulnerab|race condition|deadlock|intermittent|flaky)\b/i, 4],
    [/애매|모호|확실하지|잘 모르|unclear|ambiguous|not sure/i, 3],
    [/전체\s*리팩터|대규모|여러\s*모듈|cross-cutting|large refactor|whole (app|system)/i, 3],
  ],
  fable: [
    [/몇\s*시간|장시간|밤새|끝까지\s*알아서|전부\s*다\s*만들어|처음부터\s*끝까지|long-running|end to end|overnight|from scratch/i, 4],
  ],
};

function score(task) {
  const scores = { haiku: 0, sonnet: 0, opus: 0, fable: 0 };
  const hits = [];
  for (const [route, rules] of Object.entries(SIGNALS)) {
    for (const [re, w] of rules) {
      const m = task.match(re);
      if (m) { scores[route] += w; hits.push(`${route}:${m[0].trim()}`); }
    }
  }
  // Long, multi-part requests need judgement; very short ones rarely do.
  const parts = task.split(/\n|그리고|또한|;|\band\b|\balso\b/i).filter((s) => s.trim().length > 8).length;
  if (task.length > 600 || parts >= 4) { scores.opus += 3; hits.push('opus:긴/여러 요구'); }
  if (task.length < 60 && scores.opus === 0) scores.haiku += 1;
  return { scores, hits };
}

// Free OpenAI-compatible endpoint that needs no key (Pollinations, GPT-OSS). Answers with one label.
// Anonymous tier: one queued request per IP and a few seconds per answer, so keep the wait short.
function askFreeClassifier(task, allowed, timeoutMs = 6000) {
  const body = JSON.stringify({
    model: 'openai',
    max_tokens: 400,
    reasoning_effort: 'low',
    messages: [
      { role: 'system', content: 'You route coding tasks to the cheapest model that can do them well. Labels: '
        + 'haiku = lookup, reading, summarizing, translating, tiny mechanical edits; '
        + 'sonnet = clear, bounded implementation, bug fix with known cause, tests, bulk edits; '
        + 'opus = design, architecture, unclear root cause, security, large refactors, judgement calls'
        + (allowed.includes('fable') ? '; fable = very long autonomous multi-hour work end to end' : '')
        + `. Answer only with JSON: {"label": "<one of ${allowed.join('|')}>"}` },
      { role: 'user', content: task.slice(0, 2000) },
    ],
  });
  return new Promise((resolve) => {
    const req = https.request('https://text.pollinations.ai/openai', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        try {
          const text = JSON.parse(out).choices[0].message.content.toLowerCase();
          // Anything that is not exactly one of the labels counts as no answer.
          const label = (text.match(/"label"\s*:\s*"(\w+)"/) || [])[1] || text.trim().replace(/[^a-z]/g, '');
          resolve(allowed.includes(label) ? label : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

async function decide(task) {
  const st = state.load();
  if (st.enabled === false) return { route: 'self', by: 'off', why: '라우팅 꺼짐 (--on 으로 켜기)' };
  const allowed = ROUTES.filter((r) => r !== 'fable' || st.allowFable);
  const { scores, hits } = score(task);
  if (!st.allowFable) { scores.opus += scores.fable; scores.fable = 0; }
  const ranked = allowed.slice().sort((a, b) => scores[b] - scores[a]
    || ROUTES.indexOf(b) - ROUTES.indexOf(a)); // ties go to the more capable model
  const [top, second] = ranked;
  const margin = scores[top] - scores[second];
  const why = hits.length ? hits.slice(0, 4).join(', ') : '신호 없음';

  // Clear rule result: done. Unclear: let the free classifier pick among the labels.
  if (scores[top] > 0 && margin >= 2) return { route: top, by: 'rules', why };
  if (st.llm !== false) {
    const pick = await askFreeClassifier(task, allowed);
    if (pick) return { route: pick, by: 'free-ai', why: `규칙 애매(${why}) → 무료 AI 판정` };
  }
  // Unsure and no classifier answer: Sonnet is the safe middle.
  return { route: 'sonnet', by: 'rules', why: `${why} (확신 낮음 → 기본값)` };
}

function toggle(key, value, label) {
  const st = state.load();
  st[key] = value;
  state.save(st);
  console.log(`${label}: ${value ? '켜짐' : '꺼짐'}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--on' || args[0] === '--off') return toggle('enabled', args[0] === '--on', 'token-router');
  if (args[0] === '--llm') return toggle('llm', args[1] !== 'off', '무료 AI 판별');
  if (args[0] === '--fable') return toggle('allowFable', args[1] === 'on', 'Fable 라우팅');
  if (args[0] === '--stats') return console.log(state.stats());
  const task = args.join(' ').trim() || require('fs').readFileSync(0, 'utf8').trim();
  if (!task) { console.error('usage: node route.js "<task>"'); process.exit(2); }
  const d = await decide(task);
  state.log({ type: 'route', route: d.route, by: d.by, task: task.slice(0, 120) });
  console.log(JSON.stringify(d));
}

if (require.main === module) main();
module.exports = { decide, score };
