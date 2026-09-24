# Claude_Skills

개인 Claude Code 스킬 모음. 스킬마다 폴더 하나, 폴더 안에 `SKILL.md`.

## 스킬 목록

- [token-router](token-router/) — 작업을 시작하기 전에 가장 싼 Claude 모델(haiku/sonnet/opus/fable)을 골라 그 모델의 하위 에이전트로 위임. 로컬 규칙 우선, 애매하면 무료 AI(키 불필요)로 판정. 판정 자체는 Claude 토큰을 쓰지 않음.

## 설치

각 스킬 폴더의 `node install.js`를 실행하면 `~/.claude/skills/<이름>`에 복사되고 새 Claude 세션부터 쓰입니다.
