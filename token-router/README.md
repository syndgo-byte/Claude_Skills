# token-router

> Claude Code에서 **긴 대화를 자동으로 끊고 정리해서 다음 세션으로 넘기는** Claude Code 스킬

대화가 길어지면 토큰이 빠르게 줄어듭니다. token-router는 대화 맥락이 커지면:
- **80k**: 경고만 띄움 (계속 작업 가능)
- **200k**: 정리 후 handoff 파일 작성 (입력 잠금)
- **/compact**: 한 번 입력 → 자동으로 이어감 (새 대화 X)

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
Claude: ✅ "완료. /compact 입력하세요"
사용자: ㄱㄱ  ← 또는 /c, /ㄱ, /compact
↓
Claude: ▶ "압축 완료, 이어서 진행합니다"
↓
사용자: "그 다음은..."
Claude: (handoff 읽고 자동으로 이어감)
```

---

## 작동 방식

| 단계 | 맥락 크기 | 무엇이 일어나는가 |
|---|---|---|
| **경고** | 80k 초과 | ⚠ Windows 풍선·소리 알림. 작업은 계속 |
| **강제 작성** | 200k 초과 | 📝 Claude가 하던 작업만 마무리 → 파일 백업 → handoff 작성 |
| **입력 잠금** | handoff 완료 후 | 🔒 이후 질문을 모두 막음. `/compact`(또는 `/c`, `/ㄱ`, `ㄱㄱ`) 입력 대기 |
| **압축 후 이어감** | /compact 입력 | ▶ 압축 완료 → 잠금 해제 → handoff 자동 읽고 진행 |

**핵심:**
- 새 대화를 열 필요 없음 (같은 대화에서 계속)
- `/compact` 한 번만 입력하면 자동으로 이어남
- 백업은 자동 (git 없이도 파일 복원 가능)

---

## 모델 전환

token-router는 작업 난도에 따라 자동으로 모델을 제안합니다.

**상향 (Haiku → Sonnet/Opus)**
- 설계, 원인 분석, 보안 등 복잡한 작업이 들어오면 제안
- 맥락이 50k를 넘으면 제안하지 않음 (새 세션 권함)

**하향 (Opus/Sonnet → Haiku)**  *Haiku 최대한 활용*
- 조회, 요약 같은 간단한 작업이면 하향 제안
- 조건: 명확한 판정 + 1단계 이상 아래 + **맥락 50k 이하**
- 예: Opus → Sonnet → Haiku (각 1단계씩 가능)

**전환 방법**
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

## 자세한 내용

더 자세한 규칙과 설정은 [`SKILL.md`](SKILL.md)를 읽으세요. Claude가 작업할 때 따르는 규칙들입니다.
