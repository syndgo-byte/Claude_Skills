# Claude_Skills

개인 Claude Code 스킬·도구 모음. 하나씩 폴더로 관리.

## 목록

- [token-router](token-router/) — Claude 스킬. 작업을 시작하기 전에 가장 싼 Claude 모델(haiku/sonnet/opus/fable)을 골라 그 모델의 하위 에이전트로 위임. 로컬 규칙 우선, 애매하면 무료 AI(키 불필요)로 판정. 판정 자체는 Claude 토큰을 쓰지 않음.
- [claude-plugin-manager](claude-plugin-manager/) — VS Code 확장. 사이드바에서 Claude Code 플러그인을 켜고 끄고, 설명을 한글로 보고, 인기 스킬을 추천받고, 실제 사용 빈도를 분석해 안 쓰는 플러그인 정리를 도움.
- [free-ai-offers](free-ai-offers/) — VS Code 확장. 무료 AI/LLM 혜택과 마감일을 추적(OpenRouter, Vercel AI Gateway, 공식 변경 기록, 뉴스, YouTube). Claude 토큰을 쓰지 않음.
- [plugin-profiler](plugin-profiler/) — `SessionStart` 훅. 세션이 열릴 때마다 프로젝트별 실제 사용 이력(로컬 대화 기록)과 파일 종류를 보고 `enabledPlugins`를 자동으로 맞춤. 무거운 플러그인(스킬 15개 이상, 매 도구 호출마다 도는 훅)은 실사용 증거 있을 때만 켬. LLM 호출 없음.

## 설치

- Claude 스킬(`SKILL.md` 있는 폴더): 그 폴더의 `node install.js` 실행 → `~/.claude/skills/<이름>`에 복사, 새 Claude 세션부터 적용.
- VS Code 확장(`package.json`이 있고 `main`이 `extension.js`인 폴더): 해당 폴더에서
  ```
  npx @vscode/vsce package --allow-missing-repository
  code --install-extension <이름>-<버전>.vsix --force
  ```
- 훅(`plugin-profiler`): `~/.claude/settings.json`의 `hooks`에 등록. 각 폴더 README 참고.
