# Free AI Offers

VS Code 사이드바에서 무료 AI/LLM 혜택과 마감일을 추적하는 확장. Claude 토큰을 쓰지 않습니다
(`claude-plugin-manager`에서 분리한 독립 확장).

## 기능

- **마감 임박**: 종료일이 있는 혜택을 가까운 순으로 모아 D-day 표시.
- **공식 무료 공지**: Vercel·GitHub 변경 기록(RSS/Atom)에서 "free through ○월 ○일" 같은 문구를 찾아 마감일 추출. 설정 `freeAiOffers.promoFeeds`로 다른 회사 피드 추가 가능.
- **프로모션 뉴스**: Google 뉴스·YouTube(최근 업로드, 설명 전체까지 읽어 마감일 탐지)에서 무료 AI 혜택 기사/영상 수집.
- **가입 체험 크레딧 / 주기적 충전 / 상시 무료 API**: [Free-LLM 목록](https://github.com/nejib1/Free-LLM), OpenRouter, Vercel AI Gateway의 무료 등급.
- **내가 추가한 혜택**: ＋ 버튼으로 Threads/X/블로그 링크를 붙여 넣으면 본문에서 마감일을 찾아 저장.
- 항목을 클릭하면 API 키 발급, curl/Python/TS 예제, Cline·Aider·Codex CLI·Claude Code 연결법이 담긴 한글 사용법 안내가 열립니다.

## 자동 정리

- **내가 추가한 혜택**은 마감 후 7일이 지나면 자동으로 지워지고, 최대 60개로 제한됩니다. `⋯` 메뉴의 "마감 지난 항목 정리"로 바로 정리할 수도 있습니다.
- **"새 혜택" 알림 판단용 기록**은 매번 수집할 때마다 현재 데이터셋에 없는 항목을 자동으로 빼서, 계속 쌓이지 않습니다.
- 모델·뉴스 목록 자체는 매번 전체를 새로 받아와 교체하므로 과거 데이터가 누적되지 않습니다.

## 설치

```
npx @vscode/vsce package --allow-missing-repository
code --install-extension free-ai-offers-<버전>.vsix --force
```

## 참고

- 한글 설명은 무료 웹 번역기(Google, 실패 시 MyMemory)로 자동 번역해 `~/.claude/plugin-manager-ko.json`에 저장합니다. `claude-plugin-manager` 확장과 이 파일을 공유해 같은 문구를 두 번 번역하지 않습니다.
- 무료 등급으로 API를 쓰면 요청 내용이 제공사 쪽에 기록·학습에 쓰일 수 있습니다. 회사 코드나 비밀값은 보내지 마세요.
