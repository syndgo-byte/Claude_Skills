# token-router 설치·사용

Claude가 읽는 규칙은 `SKILL.md`에 있습니다. 이 README는 설치용 문서라 평소에는 Claude의 토큰을 쓰지 않습니다.

## 설치 (Claude Code에게 맡기기)

압축을 아무 곳에나 푼 뒤 Claude Code에 이렇게 말하면 됩니다.

> 이 폴더의 README 보고 token-router 스킬 설치해줘

**Claude Code가 할 일:** 이 폴더에서 아래 명령을 실행합니다. 평소 첫 모델이 Haiku가 아니라면 `--base`를 그 모델로 바꿉니다.

```bash
node install.js --base haiku
```

`install.js`가 하는 일은 다음과 같습니다.
1. 파일을 `~/.claude/skills/token-router/`로 복사합니다.
2. `~/.claude/settings.json`에 훅 6종을 등록합니다.
   - 기존 설정은 `settings.json.bak-*`로 백업합니다.
   - 다른 훅은 그대로 두고, 이전 token-router 훅만 교체합니다. 그래서 여러 번 실행해도 중복되지 않습니다.
   - `settings.json`이 깨져 있으면 아무것도 바꾸지 않고 중단합니다.
3. 간단한 자가 점검을 합니다.

설치 후 **Claude Code를 다시 시작**해야 훅이 적용됩니다. 그리고 프로젝트마다 `.gitignore`에 `.handoff/`를 추가하세요. 일지에 요청 원문과 실행한 명령이 그대로 남습니다.

```bash
node install.js --dry-run     # 등록될 훅만 보기 (아무것도 안 바꿈)
node install.js --uninstall   # 훅 제거 (파일은 남음)
```

## 파일

| 파일 | 역할 |
|---|---|
| `SKILL.md` | 작업 규칙: 계획·모델 배정, 매 답변 세션 판단, handoff 양식, 엑셀은 스크립트로 처리 |
| `route.js` | 작업 → 모델 + effort 판정 (로컬 규칙). 훅: 작업과 모델이 안 맞으면 전송 전에 전환 제안 |
| `handoff.js` | 대화 맥락 크기 측정 → 새 세션 권장, 새 대화 시작 시 "이어서 할까요?" 제안 |
| `journal.js` | N턴마다 작업 일지를 `.handoff/journal-*.md`에 자동 기록 |
| `snapshot.js` | handoff 직전 바뀐 파일을 프로젝트의 `backup-claude/`에 압축 백업, `--restore`로 복원 (git 불필요, 5GB 이하 유지) |
| `state.js` | 설정·기록 (`~/.claude/token-router/`) |
| `install.js` | 설치·업데이트·제거 |

## 훅이 하는 일

| 이벤트 | 스크립트 | 동작 | 토큰 |
|---|---|---|---|
| `UserPromptSubmit` | `route.js` | 질문을 모델에 보내기 **전에** 난도를 판정합니다. 현재 모델과 안 맞으면 질문을 막고 전환을 제안합니다. | 0 (막힌 질문과 안내문은 사용자에게만 보이고 모델 맥락에 들어가지 않음) |
| `UserPromptSubmit` | `handoff.js` | 맥락이 80k, 160k처럼 기준을 한 단계 넘을 때마다 한 줄 알림을 띄웁니다. 모델이 새 세션 전환과 handoff 작성을 제안하게 됩니다. | 알림 1회당 약 100토큰 (모델이 읽어야 동작하므로 의도된 비용). 기준 미만일 때는 0 |
| `Stop` | `journal.js` | 새 요청이 N턴(기본 5) 쌓였을 때만 일지를 기록합니다. | 0 (출력 없음) |
| `PreCompact`, `SessionEnd` | `journal.js` | 압축 직전과 세션 종료 때 남은 내용을 기록합니다. | 0 (출력 없음) |
| `SessionStart` | `handoff.js start` | **이어하기 제안.** 새 대화를 열거나 `/clear`하면 프로젝트 폴더에서 7일 이내 가장 최근 handoff 파일을 찾습니다. Claude가 첫 답변에서 "이전 작업(목표: …)을 이어서 할까요?"라고 묻고, 예라고 하면 그 파일만 읽고 이어갑니다. 다 읽은 handoff는 `.handoff/done/`으로 옮겨 다시 묻지 않습니다. 파일 이름을 입력할 필요가 없습니다. | handoff가 있을 때만 약 80토큰 |
| `PostToolUse` | `handoff.js guard` | **작업 루프 중단.** 도구를 실행할 때마다 맥락 크기를 확인합니다. 기준(기본 150k)을 넘으면 예외 없이 Claude에게 "하던 편집만 마무리하고 handoff를 쓰고 멈춰라"라고 지시합니다. 150k, 300k처럼 기준을 한 단계 넘을 때마다 한 번씩만 지시합니다. | 경고 1회당 약 150토큰. 기준 미만일 때는 0 |

**작업 루프 중단이 필요한 이유:** 질문 알림(`UserPromptSubmit`)은 질문을 보낼 때만 실행됩니다. 그래서 질문 하나에서 도구를 수십 번 돌리는 동안에는 알림이 뜨지 않습니다. 실제로 질문 4개에 호출 361번, 맥락 680k까지 불어나 139M 토큰을 쓴 사례가 있었습니다. 1M 맥락 모델은 자동 압축도 늦게 일어나서, 이 훅이 일찍 끊어 주는 역할을 합니다.

### 모델 전환 제안

- **상향 (예: Haiku → Opus)**: 설계, 원인 분석, 보안 같은 opus급 작업이 들어오면 제안합니다. 맥락이 50k를 넘었으면 모델을 바꾸는 대신 handoff 후 새 세션을 권합니다.
- **하향 (예: Opus → Haiku)**: 조회나 요약처럼 확실히 가벼운 작업이고, 두 단계 아래 모델로 충분하며, **맥락이 30k 이하일 때만** 제안합니다.
  - 이렇게 조건을 둔 이유: 캐시는 모델별로 따로 쌓입니다. 그래서 싼 모델로 바꾸면 첫 답변에서 대화 전체를 캐시 없이 다시 읽습니다. 맥락이 100k라면 그 한 번이 Opus가 캐시에서 읽는 비용보다 비쌉니다.
  - Haiku는 맥락 창이 200K라서, 맥락이 150k를 넘으면 Haiku로 가라는 제안은 하지 않습니다.
- **전환 방법**: `/model`에서 권장 모델을 고른 뒤 **같은 질문을 그대로** 다시 보냅니다.
- **그대로 진행**: 같은 질문을 10분 안에 한 번 더 보냅니다. 문장을 바꾸면 다시 판정합니다.
- **현재 모델 판단**: 마지막 답변 기록으로 판단합니다. 새 세션의 첫 질문에서는 `--base` 모델로 가정합니다.

## 명령

```bash
node route.js "엑셀 20개 읽어서 분류별 합계 스크립트 만들어줘"   # {"route":"sonnet","effort":"medium",...}
node route.js --stats            # 판정 통계와 현재 설정
node route.js --on | --off       # 전체 켜기/끄기
node route.js --ask-at opus      # 이 등급 이상 작업일 때만 상향 제안 (sonnet|opus|fable, 기본 opus)
node route.js --down on|off      # 하향 제안 (기본 켜짐)
node route.js --base haiku       # 새 세션을 보통 어떤 모델로 시작하는지
node route.js --fable on|off     # Fable 배정 허용 (기본 금지)
node route.js --llm on|off       # 애매할 때 외부 무료 AI에 질문 원문 전송 (기본 꺼짐)

node handoff.js check            # 가장 최근 대화의 맥락 크기와 권장 여부
node handoff.js name             # handoff-mmdd-hhmm.md
node handoff.js --threshold 60000   # 질문 사이 새 세션 권장 기준 (기본 80k)
node handoff.js --loop 120000       # 작업 루프 중단 기준 (기본 150k)
node handoff.js where               # 최근 대화의 handoff·백업 위치 (수정한 파일 기준)
node handoff.js --home E:/handoff   # 파일 수정 없는 대화의 handoff 위치 (기본 D:\Claude_handoff)

node snapshot.js                    # 지금 폴더에서 바뀐 파일 백업
node snapshot.js --list             # 이 프로젝트의 백업 목록
node snapshot.js --restore latest data/1월.xlsx     # 파일 하나를 최근 백업으로 복원
node snapshot.js --restore 20260924-143111         # 그 시점 상태로 백업된 파일 전부 복원
node snapshot.js --limits 5 200     # 프로젝트당 GB · 파일 하나 MB 한도

node journal.js --every 3        # 일지 기록 주기 (기본 5턴)
node journal.js now              # 지금 바로 기록
```

## 수동 설치 (install.js를 못 쓸 때)

파일을 `~/.claude/skills/token-router/`에 복사하고 `~/.claude/settings.json`에 아래를 합칩니다. 경로는 본인 PC에 맞게 바꾸세요.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [
        { "type": "command", "command": "node \"C:/Users/나/.claude/skills/token-router/route.js\" hook" },
        { "type": "command", "command": "node \"C:/Users/나/.claude/skills/token-router/handoff.js\" hook" }
      ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node \"C:/Users/나/.claude/skills/token-router/journal.js\" hook" } ] }
    ],
    "PreCompact": [
      { "hooks": [ { "type": "command", "command": "node \"C:/Users/나/.claude/skills/token-router/journal.js\" hook" } ] }
    ],
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "node \"C:/Users/나/.claude/skills/token-router/journal.js\" hook" } ] }
    ],
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "node \"C:/Users/나/.claude/skills/token-router/handoff.js\" start" } ] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [ { "type": "command", "command": "node \"C:/Users/나/.claude/skills/token-router/handoff.js\" guard" } ] }
    ]
  }
}
```

## handoff 저장 위치

기준은 대화를 연 위치가 아니라 **그 대화에서 수정한 파일**입니다.

- **파일을 수정한 대화** (예: `.py` 수정): 그 파일이 속한 프로젝트 폴더(`.git`·`pyproject.toml`·`package.json`·`requirements.txt` 등이 있는 가장 가까운 상위 폴더, 없으면 파일이 있는 폴더)에 handoff·백업·일지를 둡니다.
- **파일 수정 없이 명령만 친 대화**: handoff·일지는 **`D:\Claude_handoff`**에 두고 백업은 하지 않습니다. 위치는 `node handoff.js --home <폴더>`로 바꿀 수 있습니다.
- `~/.claude` 설정·임시 폴더·handoff 파일을 고친 것은 프로젝트 작업으로 치지 않습니다.
- handoff가 작성되면 위치를 기록해 두므로, 새 대화를 어느 폴더에서 열어도 "이전 작업이 있습니다"를 띄웁니다.

## handoff 후 흐름

1. handoff 파일이 작성되면 화면에 **"✅ 작성 완료. 새 대화(+ 버튼)를 열거나 /clear 를 입력한 뒤 '이어서 해줘'라고 하세요"**가 뜹니다.
2. 그 대화에서 질문을 더 보내면 **훅이 막고** 같은 안내를 다시 띄웁니다(토큰 0). `/clear` 같은 명령은 통과합니다.
3. 새 대화(또는 `/clear` 후)에서 **"📄 이전 작업이 있습니다"**가 뜨면 "이어서 해줘"라고 하세요.

## 스냅샷(백업) 규칙

handoff 직전(맥락 초과 경고, 새 세션 권장)에 Claude가 `snapshot.js`를 실행합니다. git은 쓰지 않습니다.

- **저장 위치**: 각 프로젝트 폴더 안 `backup-claude\<날짜-시각>\<원래 경로>.gz`
- **압축 저장**: 백업은 `정산.xlsx.gz`처럼 압축돼 있습니다. 그래서 `*.xlsx`·`*.py`를 찾는 스크립트나 Claude의 검색에 **백업 사본이 섞이지 않고**, 용량도 줄어듭니다. 폴더 안 `.ignore`로 Claude Code 검색에서도 빠집니다.
- **무엇을**: 첫 백업은 프로젝트 전체, 이후에는 지난 백업 이후 바뀐 파일만 저장합니다.
- **제외**: `.env`·키·인증서·`credentials`/`secrets` 파일, 임시 파일(`~$*`, `.tmp`, `.log`), 200MB 넘는 파일, `node_modules`·`.git`·가상환경·빌드 폴더·`.handoff/`
- **용량**: `backup-claude`를 **프로젝트마다 5GB 이하로 유지**합니다(압축 후 크기 기준). 넘으면 오래된 버전부터 지우지만 **파일마다 가장 최근 사본은 지우지 않습니다.**
- **복원**: `node snapshot.js --restore <날짜-시각|latest> [파일]`. 각 파일을 그 시점 이전의 가장 최근 백업으로 되돌립니다. **복원 직전 상태를 먼저 백업**하므로 복원도 되돌릴 수 있습니다. 되돌릴지는 사용자가 정합니다.
- `backup-claude` 폴더를 통째로 지워도 프로젝트에는 영향이 없습니다.
- Claude가 편집 도구로 고친 파일만 되돌릴 때는 Claude Code의 `/rewind`가 더 간단합니다. 백업은 스크립트나 사람이 바꾼 파일까지 보관합니다.

## 알려진 한계

- 판정은 키워드 규칙이라 가끔 틀립니다. 틀리면 같은 질문을 한 번 더 보내서 넘기면 됩니다.
- 훅은 모델을 **직접 바꾸지 못합니다.** 전환은 `/model`로 사람이 합니다.
- Windows에서는 사용자 폴더에 한글이 들어 있으면 훅 실행에 문제가 생길 수 있습니다. 그럴 때는 `settings.json`의 경로를 `~/.claude/skills/token-router/...` 형태로 바꿔 보세요.
