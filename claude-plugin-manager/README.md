# Claude Plugin Manager

VS Code 사이드바에서 Claude Code 플러그인을 켜고 끄고, 스킬 설명을 보고, 요즘 인기 있는 스킬을 추천받는 로컬 확장입니다.

무료 AI 혜택 추적 기능은 별도 확장 `free-ai-offers`(이 저장소의 형제 폴더)로 분리되었습니다.

## 기능

- **설치된 플러그인**: 체크박스로 켜기/끄기(`~/.claude/settings.json`의 `enabledPlugins`를 수정). 펼치면 스킬·명령·에이전트·훅·MCP·LSP 목록과 설명이 보입니다. 스킬을 클릭하면 `SKILL.md`가 열립니다.
- **상태바**: `Claude 켜진 수/전체`. 마우스를 올리면 플러그인별 설명, 클릭하면 한 번에 켜기/끄기.
- **추천 스킬**
  - *내 프로젝트에 맞는 플러그인*: 등록된 마켓플레이스 중 설치하지 않은 플러그인을, 현재 워크스페이스 파일 종류(Python, HTML 등)와 맞춰 점수를 매깁니다.
  - *GitHub 인기 / 급상승*: GitHub 검색 API로 `claude-code-plugin`, `claude-skills` 등 토픽 저장소를 모아 별 수, 하루 평균 별 증가량, 최근 커밋, 프로젝트 적합도로 순위를 냅니다. 결과는 6시간 캐시합니다.
  - `.claude-plugin/marketplace.json`이 있는 저장소는 설치 버튼으로 바로 등록·설치합니다.
- **한글 설명**: 설명은 한글로 표시하고, 마우스를 올리면 원문도 함께 보입니다. 기본 사전은 `lib/ko.json`이고, 새로 설치한 플러그인과 추천 목록은 무료 웹 번역기(Google, 실패 시 MyMemory)로 자동 번역해 `~/.claude/plugin-manager-ko.json`에 저장합니다. 이 파일을 직접 고쳐도 바로 반영됩니다. 설정 `claudePluginManager.koreanDescriptions`를 끄면 원문으로 표시합니다.
- **업데이트 알림**: 6시간마다 각 플러그인의 GitHub 저장소를 `git ls-remote`로 확인하고, 설치한 커밋 이후 플러그인 폴더가 바뀌었으면 `⬆ 업데이트`로 표시합니다. 클릭 한 번으로 카탈로그 갱신 후 업데이트합니다.
- **중복 정리**: 같은 플러그인이 여러 마켓플레이스에서 두 번 설치돼 켜져 있으면 표시하고, 하나만 남기고 끌 수 있게 안내합니다.
- **사용량 분석**: 이 PC의 Claude Code 대화 기록에서 플러그인·개인 스킬 호출 횟수를 셉니다. 설정 기간(기본 30일) 동안 한 번도 안 쓴 플러그인은 표시하고, 끄기/제거를 고를 수 있는 정리 창을 띄웁니다. Claude 토큰을 쓰지 않습니다.
- **개인 스킬**: 마켓플레이스가 아닌 `~/.claude/skills`에 직접 둔 스킬도 목록에 보여주고, 체크박스로 켜고 끕니다(끄면 `~/.claude/skills-disabled`로 이동).

## 참고

- 켜기/끄기와 설치는 **새 Claude 세션부터** 적용됩니다.
- GitHub 호출 한도(비로그인 분당 10회)를 넘으면 설정 `claudePluginManager.githubToken`에 권한 없는 토큰을 넣으세요.
- 제3자 플러그인은 PC에서 훅과 스크립트를 실행할 수 있으니 저장소를 확인한 뒤 설치하세요.

## 빌드

```
npx @vscode/vsce package --allow-missing-repository
code --install-extension claude-plugin-manager-<버전>.vsix --force
```
