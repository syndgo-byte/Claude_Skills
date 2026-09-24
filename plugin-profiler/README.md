# plugin-profiler

Claude Code `SessionStart` 훅. 세션이 열릴 때마다, 그 프로젝트 폴더에서 실제로 어떤 플러그인을 썼는지(로컬 대화 기록)와
프로젝트 종류(파일 확장자)를 보고 `~/.claude/settings.json`의 `enabledPlugins`를 자동으로 맞춥니다.
**LLM 호출 없음** — 전부 로컬 텍스트 매칭/카운팅.

## 왜 세션 시작 시점인가

Claude Code는 세션이 열릴 때 스킬/명령 목록을 한 번 고정해서 시스템 프롬프트에 넣습니다. 그래서 켜고 끄는 건 항상
"다음 세션부터 적용"입니다. 대화 도중 방금 한 말을 보고 그 자리에서 스킬을 켜는 건 구조적으로 불가능합니다
(이미 컨텍스트에 안 실려 있으면 그 턴엔 못 씀). 그래서 이 도구는 **세션이 열리는 시점**, 아직 목록이 고정되기 전에
개입하는 `SessionStart` 훅으로 만들었습니다. 대화 주제가 세션 중간에 바뀌는 건 못 따라갑니다 — 세션 단위 최적화지
턴 단위 실시간 최적화가 아닙니다.

## 판단 기준

- **항상 켜짐 (가벼움)**: 스킬·명령 몇 개뿐이고 훅도 없는 플러그인. 어차피 매 턴 비용이 작아서 그냥 켜 둡니다.
  (`context7`, `commit-commands`, `claude-md-management`, `frontend-design`, `andrej-karpathy-skills`,
  `academy-guide`, `claude-api`, `discernment-nudge`, `receipts`, `document-skills`, `pyright-lsp`)
- **무거운 것 (opt-in)**: 스킬 15~25개거나, 거의 모든 도구 호출마다 도는 훅이 있는 플러그인. 아래 둘 중 하나가
  있어야 켭니다.
  1. **이 프로젝트에서 최근 60일간 실제로 3회 이상 호출된 기록** (`~/.claude/projects/**/*.jsonl`에서 스킬/에이전트/명령
     호출만 셈 — 언급이 아니라 실제 호출)
  2. **그 플러그인과 맞는 파일이 프로젝트에 있음** (예: `.png`/`.svg`/`.pptx` 있으면 `example-skills`). 단, 이 검사는
     **진짜 프로젝트 폴더**(`.git`, `package.json` 등 마커 있는 곳)에서만 돕니다 — 홈 디렉터리처럼 마커 없는 곳에서
     하면 아무 상관없는 파일 하나로 오작동하기 쉬워서 뺐습니다.
  둘 다 없으면 끕니다.
  (`superpowers`, `planning-with-files`, `mattpocock-skills`, `caveman`, `example-skills`, `security-guidance`)

`security-guidance`는 파일타입 신호도 없음 — 숨은 API 호출(Stop마다 LLM 리뷰)이 있는 플러그인이라, 실사용 증거
없이는 절대 자동으로 안 켭니다.

## 설치

`~/.claude/settings.json`에 이미 등록되어 있습니다 (`hooks.SessionStart`). 다른 PC에 옮길 땐:

```json
"hooks": {
  "SessionStart": [
    { "hooks": [{ "type": "command", "command": "node \"<이 폴더 경로>/apply.js\"", "timeout": 8 }] }
  ]
}
```

## 확인/디버깅

```
node apply.js --dry-run --verbose   # 표준입력으로 {"cwd": "..."} 넣으면 실제로 쓰지 않고 결과만 출력
cat decisions.log                   # 세션마다 무엇을 켜고 껐는지, 왜인지 기록
```

`ALWAYS_ON` / `HEAVY` 목록과 사용 기준(`USAGE_THRESHOLD`, `USAGE_WINDOW_DAYS`)은 `profile.js` 상단에서 고칩니다.
