#!/usr/bin/env node
'use strict';
// node route.test.js  -> checks that common requests go to the expected model
const { decide } = require('./route');

const CASES = [
  ['README 오타 수정해줘', 'haiku'],
  ['버튼 색 좀 고쳐줘', 'sonnet'],
  ['구현된 함수 어디 있어?', 'haiku'],
  ['이 기능 어디서 쓰여?', 'haiku'],
  ['수정본 파일 목록 보여줘', 'haiku'],
  ['plan.md 읽어줘', 'haiku'],
  ['결정된 설정값 알려줘', 'haiku'],
  ['요약해서 표로 만들어줘', 'sonnet'],
  ['로그인 API 추가해줘', 'sonnet'],
  ['로그인 기능 구현해줘', 'sonnet'],
  ['로그인 버그 고쳐줘', 'opus'],
  ['가끔 로그인이 풀리는데 원인 찾아줘', 'opus'],
  ['이 모듈 구조를 어떻게 잡을지 고민돼', 'opus'],
];

(async () => {
  let failed = 0;
  for (const [task, want] of CASES) {
    const d = await decide(task);
    const ok = d.route === want;
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${want.padEnd(6)} got ${d.route.padEnd(6)} | ${task} | ${d.why}`);
  }
  console.log(failed ? `\n${failed}개 실패` : '\n모두 통과');
  process.exit(failed ? 1 : 0);
})();
