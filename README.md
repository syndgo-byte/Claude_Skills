# Claude_Skills

개인 Claude Code 스킬·도구 모음. 하나씩 폴더로 관리.

## 목록

- [token-router](token-router/) — Claude 스킬. 작업을 시작하기 전에 가장 싼 Claude 모델(haiku/sonnet/opus/fable)을 골라 그 모델의 하위 에이전트로 위임. 로컬 규칙 우선, 애매하면 무료 AI(키 불필요)로 판정. 판정 자체는 Claude 토큰을 쓰지 않음.
- [claude-plugin-manager](claude-plugin-manager/) — VS Code 확장. 사이드바에서 Claude Code 플러그인을 켜고 끄고, 설명을 한글로 보고, 인기 스킬을 추천받고, 무료 AI 혜택과 마감일을 추적.

## 설치

- Claude 스킬(`SKILL.md` 있는 폴더): 그 폴더의 `node install.js` 실행 → `~/.claude/skills/<이름>`에 복사, 새 Claude 세션부터 적용.
- VS Code 확장(`claude-plugin-manager`): 해당 폴더에서
  ```
  npx @vscode/vsce package --allow-missing-repository
  code --install-extension claude-plugin-manager-<버전>.vsix --force
  ```
