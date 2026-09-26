# token-router

> Claude Code에서 **긴 대화를 자동으로 끊고 정리해서 다음 세션으로 넘기는** Claude Code 스킬

대화가 길어지면 토큰이 빠르게 줄어듭니다. token-router는 대화 맥락이 커지면:
- **80k**: 경고만 띄움 (계속 작업 가능)
- **200k**: 정리 후 handoff 파일 작성 → 자동 압축 후 그대로 이어감 (입력 잠금 없음)

---

## 빠른 시작

### 설치 (60초)

이 폴더를 다운로드한 뒤 Claude Code 터미널에서:

```bash
node install.js
```

또는 Claude Code에 말하면:

> 이 폴더의 README 보고 token-router 설치해줘

설치 후 **VSCode를 다시 시작**하세요.

### 사용 예시

```
사용자: "이 엑셀 20개 읽어서..."
↓ (작업 진행 중)
↓ (맥락 80k 도달)
Claude: ⚠ 경고 (작업은 계속)
↓
↓ (맥락 200k 도달)
Claude: 📝 "인수인계 작성 중..."
Claude: (백업 + handoff 파일 작성)
Claude: ✅ "인수인계 파일 작성 완료" (입력 안 막힘)
↓ (자동 압축)
Claude: (handoff 읽고 자동으로 이어감)
```

---

## 작동 방식

| 단계 | 맥락 크기 | 무엇이 일어나는가 |
|---|---|---|
| **경고** | 80k 초과 | ⚠ Windows 풍선·소리 알림. 작업은 계속 |
| **강제 작성** | 200k 초과 | 📝 Claude가 하던 작업만 마무리 → 파일 백업 → handoff 작성 |
| **압축 후 이어감** | 자동 압축 | ▶ 입력 잠금 없이 handoff 자동 읽고 진행 |

**핵심:**
- 새 대화를 열 필요 없음 (같은 대화에서 계속)
- `/compact`를 입력할 필요 없음
- 백업은 자동 (git 없이도 파일 복원 가능)

---

## 실시간 토큰 모니터링 (VSCode Extension)

### 기능

VSCode의 **Activity Bar(왼쪽 아이콘 영역)**에 토큰 사용량을 **실시간으로 표시**합니다:

```
🟢 75.9k (47%)     ← 정상 범위
🟡 95.2k (59%)     ← 경고 수준 (70k+)
🟠 105.3k (66%)    ← 강제 작성 수준 (80k+)
🔴 201.3k (100%)   ← handoff (200k+)
```

**특징:**
- ✅ 대화 마다 자동 업데이트
- ✅ 여러 탭/세션 동시 지원
- ✅ 기준은 handoff와 동일 (경고 80k, handoff 200k — `--threshold`, `--loop`로 변경)
- ✅ 클릭하면 상세 정보 표시

### 작동 원리

```
1. 사용자가 질문 입력 (어느 탭이든 상관없음)
   ↓
2. Claude Code의 UserPromptSubmit hook 실행
   ↓
3. context-monitor.js --terminal 실행
   ├─ 최신 transcript 파일 찾기
   ├─ 토큰 사용량 계산
   ├─ ~/.claude/context-monitor.json 생성
   └─ 터미널에 색상 배너 출력
   ↓
4. VSCode Extension이 context-monitor.json 감시
   ├─ 파일 변경 감지
   └─ Activity Bar 아이콘 색상 즉시 업데이트
```

### 여러 탭에서의 동작

각 Claude Code 세션/탭마다 독립적으로 작동합니다:

```
탭 A (토큰 50k)         탭 B (토큰 80k)         탭 C (토큰 120k)
    🟢                       🟠                       🟠

↓ 탭 B에서 질문 입력
      Activity Bar: 🟠 80.5k (50%) ← 탭 B 데이터로 업데이트

↓ 탭 C로 이동해서 질문 입력
      Activity Bar: 🟠 125.3k (80%) ← 탭 C 데이터로 업데이트
```

**결과:**
- 활성화된 탭의 토큰 사용량만 표시
- 각 탭은 완전히 독립적
- 다른 탭에는 영향 없음

### 파일 위치

| 파일 | 위치 |
|---|---|
| Extension | `~/.vscode/extensions/token-router-indicator/` |
| 토큰 데이터 | `~/.claude/context-monitor.json` |
| Hook 설정 | `~/.claude/settings.json` (UserPromptSubmit) |

---

## 모델 전환

token-router는 작업 난도에 따라 자동으로 모델을 제안합니다.

### 모델별 신호 (const SIGNALS)

**🟢 Haiku** (기본 모델 - 빠르고 저렴)
- 검색, 조회: "어디에 있어", "찾아", "검색"
- 읽기, 요약: "읽어", "요약", "설명해"
- 번역, 간단 수정: "번역", "주석 달아", "오타 수정"

**🟡 Sonnet** (균형잡힌 모델)
- 구현, 기능: "구현", "추가해", "기능 만들어"
- 테스트, 변환: "테스트", "변환", "스크립트"
- 개선, 최적화: "리팩터", "정리해", "최적화"
- **길이 기반**: 300-500자 또는 3개 부분 요청

**🔴 Opus** (강력한 모델)
- 버그/원인 분석: "버그", "왜 안 돼", "원인", "디버깅"
- 설계, 아키텍처: "설계", "구조", "트레이드오프"
- 보안, 성능: "보안", "성능 분석", "취약점"
- **길이 기반**: 500자 이상 또는 4개 이상 부분 요청

**🟣 Fable** (초장시간 작업)
- 장시간 자동 작업: "장시간", "밤새", "처음부터 끝까지"

### 길이 기반 단계화

```
텍스트 길이 → 추천 모델
━━━━━━━━━━━━━━━━━━━━━━━━
< 300자    → Haiku (기본)
300-500자  → Sonnet (+2점)
> 500자    → Opus (+2점)

요청 부분 → 추천 모델
━━━━━━━━━━━━━━━━━━━━━━━━
1-2개    → Haiku (기본)
3개      → Sonnet (+1점)
4개+     → Opus (+2점)
```

**중요**: 신호(키워드)가 있으면 길이는 무시됨

### 전환 방법

**상향 (Haiku → Sonnet/Opus)**
- 설계, 원인 분석, 보안 등 복잡한 작업이 들어오면 제안
- 맥락이 50k를 넘으면 제안하지 않음 (새 세션 권함)

**하향 (Opus/Sonnet → Haiku)**  *Haiku 최대한 활용*
- 조회, 요약 같은 간단한 작업이면 하향 제안
- 조건: 명확한 판정 + 1단계 이상 아래 + **맥락 50k 이하**

**전환 수행**
1. 훅이 질문을 막고 제안 표시
2. `/model`에서 권장 모델 선택
3. **같은 질문을 그대로** 다시 입력 → 제안된 모델로 실행

**같은 질문을 10분 안에 한 번 더 보내면** 제안을 무시하고 현재 모델로 진행합니다.

---

## 기본 명령

```bash
# 경고 기준 변경 (기본 80k)
node handoff.js --threshold 60000

# 강제 작성 기준 변경 (기본 200k)
node handoff.js --loop 150000

# 가장 최근 대화의 크기 확인
node handoff.js check

# Windows 알림 끄기
node handoff.js --toast off
```

---

## 설치 자세히

<details>
<summary><strong>Claude Code에게 맡기기 (권장)</strong></summary>

이 폴더에서:

```bash
node install.js
```

`install.js`가 하는 일:
1. 파일을 `~/.claude/skills/token-router/`에 복사
2. `~/.claude/settings.json`에 훅 6개 등록
3. 기존 token-router 훅은 자동으로 교체 (중복 없음)
4. 자가 점검 실행

옵션:
```bash
node install.js --dry-run      # 등록될 훅만 보기
node install.js --uninstall    # 훅 제거 (파일은 남음)
```

</details>

<details>
<summary><strong>수동 설치</strong></summary>

파일을 `~/.claude/skills/token-router/`에 복사한 뒤 `~/.claude/settings.json`에 아래 내용을 합칩니다. (경로는 본인 PC에 맞게)

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [
        { "type": "command", "command": "node \"C:/Users/이름/.claude/skills/token-router/handoff.js\" hook" }
      ] }
    ],
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "node \"C:/Users/이름/.claude/skills/token-router/handoff.js\" start" } ] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [ { "type": "command", "command": "node \"C:/Users/이름/.claude/skills/token-router/handoff.js\" guard" } ] }
    ]
  }
}
```

</details>

---

## 파일

| 파일 | 역할 |
|---|---|
| `SKILL.md` | Claude가 읽는 규칙 (작업 계획, handoff 양식, 단계별 배정) |
| `handoff.js` | 맥락 크기 측정 + 80k/200k 알림 + /compact 후 이어가기 |
| `snapshot.js` | handoff 직전 변경된 파일 자동 백업 |
| `journal.js` | 작업 일지 자동 기록 |
| `install.js` | 설치·업데이트·제거 |

---

## handoff 저장 위치

- **파일을 수정한 대화**: 그 프로젝트 폴더에 저장
- **명령만 친 대화**: `D:\Claude_handoff`에 저장 (변경 가능: `node handoff.js --home <경로>`)

---

## 알려진 한계

- Windows 사용자명에 한글이 있으면 훅이 문제가 생길 수 있습니다. 그럴 때는 settings.json의 경로를 `~/.claude/skills/token-router/...` 형태로 바꿔 보세요.

---

## 변경 이력

### 최근 개선 (2026-09-27)

**모델 선택 기준 개선**
- Sonnet/Opus 구분을 더 명확하게: Sonnet은 구현·기능 중심, Opus는 버그 분석·설계 중심
- 길이 기준을 더 부드럽게: 300-500자 Sonnet, 500자+ Opus (기존 600자보다 낮춤)
- 내용 신호가 없을 때만 길이로 판단

**입력 잠금 제거**
- Handoff 후 `/compact`를 입력할 필요 없음
- 그대로 하던 작업을 이어갈 수 있음

**VSCode 패널 개선**
- 모든 열려 있는 Claude 탭을 동시에 표시
- 탭별 context 실시간 업데이트
- 탭을 닫으면 패널에서도 자동 제거
- 잘린 탭 이름도 제대로 매칭

**기준 통일**
- context-monitor.js와 handoff.js가 같은 기준 사용 (경고 80k, handoff 200k)
- `--threshold`, `--loop` 설정이 화면에도 즉시 반영

---

## 자세한 내용

더 자세한 규칙과 설정은 [`SKILL.md`](SKILL.md)를 읽으세요. Claude가 작업할 때 따르는 규칙들입니다.
