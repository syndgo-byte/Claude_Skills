#!/usr/bin/env node
'use strict';
// Picks the cheapest Claude model that can do a task. Costs no Claude tokens:
// local rules decide first. An optional free external classifier (off by default, because it
// sends the task text to a third-party server) can settle unclear cases.
//
//   node route.js "<task>"          -> one-line JSON {"route", "effort", "by", "why"}
//   node route.js --stats           -> routing counts
//   node route.js --on | --off      -> routing on / off
//   node route.js --llm on|off      -> free AI classifier for unclear cases (default off)
//   node route.js --fable on|off    -> allow routing to Fable (uses extra usage credits)
//   node route.js hook              -> UserPromptSubmit hook: stops a prompt whose task does not fit
//                                      the current model and suggests switching up or down (0 tokens)
//   node route.js --down on|off     -> also suggest switching down (default on)
//   node route.js --ask-at sonnet|opus -> lowest recommendation that triggers the switch prompt (default opus)
const https = require('https');
const state = require('./state');

const ROUTES = ['haiku', 'sonnet', 'opus', 'fable'];

// Each signal adds weight to a route. Korean and English phrasings both count.
// Rules marked weak are verbs that show up inside almost any request ("읽어서 ... 만들어줘"),
// so they only count when nothing asks for real work.
const SIGNALS = {
  haiku: [
    [/어디(에|서)?\s*(있|정의|쓰)|검색|목록|나열|몇\s*개|확인만|번역|뭐야|알려줘/, 3],
    [/\b(where is|search|grep|list|locate|count|translate|what does|look up)\b/i, 3],
    [/찾아|읽어|요약|분류|설명해|\b(find|read|summari[sz]e|classify|explain)\b/i, 2, 'weak'],
    [/이름\s*바꿔|리네임|rename|포맷|format|오타|typo|주석\s*달/i, 2],
  ],
  sonnet: [
    [/구현|추가해|만들어|기능|엔드포인트|컴포넌트|화면|테스트|타입\s*힌트|일괄|변환|리팩터|정리해|개선|최적화|배포/, 3],
    [/\b(implement|add|build|feature|endpoint|component|update|tests?|type hints?|convert|bulk|refactor|clean ?up|improve|optimi[sz]e|deploy)\b/i, 3],
    // Data work: the model writes a script and the script does the math.
    [/스크립트|엑셀|시트|csv|파싱|집계|합계|계산|정산|script|excel|spreadsheet|parse|aggregate/i, 2],
  ],
  opus: [
    [/설계|아키텍처|구조를?\s*(어떻게|잡)|트레이드오프|결정|어떤\s*방식|어떻게\s*가져갈|고민|전략|계획\s*세워|보안|취약|무결성|성능\s*분석|버그|고쳐|수정/, 4],
    [/왜\s*(이렇|안\s*되|느려)|원인|근본|디버깅/, 4],
    [/\b(design|architecture|why (does|is)|root cause|trade-?offs?|decide|which approach|strategy|plan|security|vulnerab|race condition|deadlock|intermittent|flaky|debug|performance analysis|bug|fix)\b/i, 4],
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
  const weak = [];
  for (const [route, rules] of Object.entries(SIGNALS)) {
    for (const [re, w, kind] of rules) {
      const m = task.match(re);
      if (!m) continue;
      if (kind === 'weak') { weak.push([route, w, m[0].trim()]); continue; }
      scores[route] += w; hits.push(`${route}:${m[0].trim()}`);
    }
  }
  if (scores.sonnet + scores.opus + scores.fable === 0) {
    for (const [route, w, word] of weak) { scores[route] += w; hits.push(`${route}:${word}`); }
  }
  // 길이 기반: Haiku 중심에서 단계적으로 Sonnet → Opus로
  const parts = task.split(/\n|그리고|또한|;|\band\b|\balso\b/i).filter((s) => s.trim().length > 8).length;

  // Sonnet 기준: 300-500자 또는 3개 부분
  if (scores.sonnet === 0 && scores.opus === 0) {
    if (task.length > 300 && task.length <= 500) { scores.sonnet += 2; hits.push('sonnet:중간길이'); }
    if (parts === 3) { scores.sonnet += 1; hits.push('sonnet:여러부분'); }
  }

  // Opus 기준: 600자 이상 또는 4개 이상 부분 (내용 신호 없을 때만)
  if (scores.opus === 0 && (scores.sonnet === 0 || scores.sonnet < 2)) {
    if (task.length > 500) { scores.opus += 2; hits.push('opus:긴문장'); }
    if (parts >= 4) { scores.opus += 2; hits.push('opus:복잡한요구'); }
  }

  if (task.length < 60 && scores.opus === 0 && scores.sonnet === 0) scores.haiku += 1;
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

// Effort is the second lever after the model: lower effort on a stronger model often beats a
// weaker model at high effort. Haiku 4.5 has no effort setting.
function effortFor(route, scores, task) {
  const big = task.length > 600;
  if (route === 'haiku') return null;
  if (route === 'sonnet') return big || scores.sonnet >= 6 ? 'high' : 'medium';
  if (route === 'opus') return big || scores.opus >= 8 ? 'high' : 'medium';
  if (route === 'fable') return 'medium';
  return null;
}

async function decide(task) {
  const st = state.load();
  if (st.enabled === false) return { route: 'self', effort: null, by: 'off', why: '라우팅 꺼짐 (--on 으로 켜기)' };
  const allowed = ROUTES.filter((r) => r !== 'fable' || st.allowFable);
  const { scores, hits } = score(task);
  if (!st.allowFable) { scores.opus += scores.fable; scores.fable = 0; }
  const ranked = allowed.slice().sort((a, b) => scores[b] - scores[a]
    || ROUTES.indexOf(b) - ROUTES.indexOf(a)); // ties go to the more capable model
  const [top, second] = ranked;
  const margin = scores[top] - scores[second];
  const why = hits.length ? hits.slice(0, 4).join(', ') : '신호 없음';

  // Clear rule result: done. Unclear: let the free classifier pick among the labels.
  const pick = (route, by, reason) => ({ route, effort: effortFor(route, scores, task), by, why: reason });
  if (scores[top] > 0 && margin >= 2) return pick(top, 'rules', why);
  if (st.llm === true) {
    const label = await askFreeClassifier(task, allowed);
    if (label) return pick(label, 'free-ai', `규칙 애매(${why}) → 무료 AI 판정`);
  }
  // Unsure and no classifier answer: Sonnet is the safe middle.
  return pick('sonnet', 'rules', `${why} (확신 낮음 → 기본값)`);
}

// Current model tier, read from the last answer in the transcript. A fresh session has no answer
// yet, so fall back to the model the user normally starts with.
function currentTier(transcript, st) {
  const m = transcript && require('./handoff').measure(transcript);
  const id = (m && m.model) || st.baseModel || 'haiku';
  return ROUTES.find((r) => id.includes(r)) || null;
}

// Runs before the prompt reaches the model and suggests a switch when the task and the current
// model do not fit: up when a stronger model is needed, down when a much cheaper one would do.
// The prompt is blocked so the model never sees it, which makes the suggestion free.
// Sending the same prompt again within 10 minutes lets it through, on whatever model is now
// selected (after /model the transcript still shows the old model until the next answer).
//
// Switching down mid-session is only worth it while the context is small: caches are per model,
// so the cheap model first re-reads the whole conversation at full price, and at 100k context
// that one read costs more than the expensive model reading it from cache.
const DOWN_MAX_CONTEXT = 50000;  // relaxed: allow longer sessions with downgrade
const HAIKU_MAX_CONTEXT = 150000; // Haiku 4.5 has a 200K window; leave room for the answer.

function switchDirection(cur, d, st, context) {
  const have = ROUTES.indexOf(cur);
  const need = ROUTES.indexOf(d.route);
  if (need > have && need >= ROUTES.indexOf(st.askAt || 'opus')) return 'up';
  // Down for clear rule verdict at least one tier lower (opus -> sonnet, sonnet -> haiku).
  if (st.down === false || d.by !== 'rules' || /확신 낮음/.test(d.why) || have - need < 1) return null;
  if (context > (st.downMaxContext || DOWN_MAX_CONTEXT)) return null;
  if (d.route === 'haiku' && context > HAIKU_MAX_CONTEXT) return null;
  return 'down';
}

async function hook() {
  let input = {};
  try { input = JSON.parse(require('fs').readFileSync(0, 'utf8')); } catch { return; }
  const prompt = String(input.prompt || '').trim();
  const st = state.load();
  if (st.enabled === false || !prompt || prompt.startsWith('/')) return;
  const cur = currentTier(input.transcript_path, st);
  if (!cur) return;
  const d = await decide(prompt);
  const ctx = require('./handoff').check(input.transcript_path);
  const context = ctx.error ? 0 : ctx.context;
  const dir = switchDirection(cur, d, st, context);
  if (!dir) return;

  const key = require('crypto').createHash('sha1').update(prompt).digest('hex');
  const pending = st.pendingSwitch || {};
  if (pending.key === key && Date.now() - pending.at < 10 * 60000) {
    delete st.pendingSwitch;
    state.save(st);
    state.log({ type: 'switch-resent', dir, from: cur, route: d.route });
    return;
  }
  st.pendingSwitch = { key, at: Date.now() };
  state.save(st);
  state.log({ type: 'switch-asked', dir, from: cur, route: d.route, effort: d.effort });
  const k = `${Math.round(context / 1000)}k`;
  const lines = dir === 'up'
    ? [
      `[token-router] 이 작업은 ${d.route}${d.effort ? ` / ${d.effort}` : ''} 권장 (현재 ${cur}). 근거: ${d.why}`,
      `→ 바꾸기: /model 에서 ${d.route} 선택 후 같은 질문을 다시 보내세요.`,
      context > 50000 ? `  (지금 맥락이 ${k}라 모델을 바꾸면 첫 답변에서 캐시 없이 전부 다시 읽습니다. handoff 파일을 만들고 새 세션에서 ${d.route}로 시작하는 편이 쌉니다.)` : '',
    ]
    : [
      `[token-router] 이 작업은 ${d.route}${d.effort ? ` / ${d.effort}` : ''}로 충분합니다 (현재 ${cur}). 근거: ${d.why}`,
      `→ 바꾸기: /model 에서 ${d.route} 선택 후 같은 질문을 다시 보내세요. (맥락 ${k}라 전환 비용 작음)`,
      '  가벼운 질문이 몇 번 이어질 때 이득입니다. 한 번만 묻고 다시 무거운 작업으로 돌아갈 거면 그대로 두세요.',
    ];
  lines.push(`→ 그대로 ${cur}로 진행: 같은 질문을 한 번 더 보내세요.`);
  console.log(JSON.stringify({ decision: 'block', reason: lines.filter(Boolean).join('\n') }));
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
  if (args[0] === '--llm') return toggle('llm', args[1] === 'on', '무료 AI 판별');
  if (args[0] === '--fable') return toggle('allowFable', args[1] === 'on', 'Fable 라우팅');
  if (args[0] === '--down') return toggle('down', args[1] !== 'off', '하향 전환 제안');
  if (args[0] === '--stats') return console.log(state.stats());
  if (args[0] === 'hook') return hook();
  if (args[0] === '--ask-at') {
    if (!['sonnet', 'opus', 'fable'].includes(args[1])) { console.error('usage: node route.js --ask-at sonnet|opus|fable'); process.exit(2); }
    const st = state.load();
    st.askAt = args[1];
    state.save(st);
    return console.log(`모델 전환 제안 기준: ${args[1]} 이상 작업`);
  }
  if (args[0] === '--base') {
    if (!ROUTES.includes(args[1])) { console.error('usage: node route.js --base haiku|sonnet|opus|fable'); process.exit(2); }
    const st = state.load();
    st.baseModel = args[1];
    state.save(st);
    return console.log(`새 세션 기본 모델(판단용): ${args[1]}`);
  }
  const task = args.join(' ').trim() || require('fs').readFileSync(0, 'utf8').trim();
  if (!task) { console.error('usage: node route.js "<task>"'); process.exit(2); }
  const d = await decide(task);
  state.log({ type: 'route', route: d.route, effort: d.effort, by: d.by, task: task.slice(0, 120) });
  console.log(JSON.stringify(d));
}

if (require.main === module) main();
module.exports = { decide, score };
