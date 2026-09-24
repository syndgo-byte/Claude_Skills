# claude-token-router

Claude Code 스킬. 작업을 시작하기 전에 그 일을 할 수 있는 가장 싼 Claude 모델을 골라, 지금 세션 모델과 다르면 그 모델의 하위 에이전트에 넘깁니다.

| 판정 | 언제 |
|---|---|
| `haiku` | 찾기, 읽기, 요약, 번역, 이름 바꾸기 같은 작은 수정 |
| `sonnet` | 범위가 분명한 기능 추가, 원인을 아는 버그 수정, 테스트, 리팩터링 |
| `opus` | 설계, 원인 불명 디버깅, 보안, 방향 결정 |
| `fable` | 몇 시간짜리 자율 작업. 추가 사용량 크레딧이 들어 기본은 꺼짐 |

판단은 `scripts/route.js`가 합니다. 먼저 이 PC에서 규칙으로 판정하고, 규칙이 애매할 때만 키가 필요 없는 무료 AI(Pollinations, GPT-OSS)에 보기 중 하나를 고르게 합니다. 어느 쪽이든 Claude 토큰은 들지 않습니다.

## 권장 사용법

세션 모델을 **Sonnet**으로 두세요. 스킬은 세션 모델 위에서 돌기 때문에, Opus 세션이면 대화와 확인 작업이 계속 Opus로 나갑니다. Sonnet 세션에서 어려운 일만 `opus` 하위 에이전트로 올려 보내는 쪽이 더 많이 아낍니다.

## 설치

```
node install.js
```

## 명령

```
node skill/scripts/route.js "작업 설명"   # 판정 (JSON 한 줄)
node skill/scripts/route.js --stats       # 최근 30일 통계와 설정
node skill/scripts/route.js --off | --on  # 끄기/켜기
node skill/scripts/route.js --llm off     # 무료 AI 판별 끄기 (작업 요약을 외부로 보내지 않음)
node skill/scripts/route.js --fable on    # Fable 판정 허용
```

## 한계

- 무료 AI는 익명 등급이라 IP당 한 번에 하나만 처리하고, 가끔 6초 제한에 걸립니다. 그러면 Sonnet으로 판정합니다.
- 무료 AI 판정은 정확도가 들쭉날쭉합니다. 판정 결과는 참고용이고, Claude가 더 잘 알면 이유를 한 줄로 밝히고 따르지 않습니다.
- 하위 에이전트는 빈 컨텍스트에서 시작하므로, 아주 작은 일은 위임하는 쪽이 더 비쌉니다.
