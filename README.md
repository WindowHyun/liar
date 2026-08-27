# 라이어 게임

사무실에서 하는 라이어 게임.

**➡️ [사용법 (exe / 웹 / 모바일)](docs/usage.md)** — 처음이라면 여기부터.

[Releases](https://github.com/WindowHyun/liar/releases)에서 exe를 받아 각자 실행하면
주소 입력 없이 자동으로 모인다. 아래는 개발자용 설명이다.

## Electron (권장) — 켜면 자동으로 모인다

```bash
npm install
npm start
```

같은 네트워크에 있는 사람들이 각자 프로그램을 켜면 **주소 입력 없이 자동으로 한 방에**
모인다. 포트 **55500** 하나만 쓴다(UDP로 서로를 찾고, 뽑힌 한 명이 TCP로 게임 서버를 연다).
처음 실행할 때 방화벽 허용 팝업이 뜨면 반드시 "허용"을 눌러야 한다.

자세한 내용: [electron/README.md](electron/README.md)

## 웹 — 한 사람만 서버를 켠다

```bash
npm run web        # 포트 4100. PORT=4200 npm run web 으로 바꿀 수 있다
```

띄우면 접속 주소가 찍힌다. 다른 사람에게 `http://<내IP>:4100` 을 알려주면 브라우저로
들어온다. 폰으로도 접속은 되지만 화면이 가로 배치라 불편하다.

## 규칙

- 최소 **2명**. 한 명이 라이어가 되고, 라이어만 제시어를 모른다(카테고리는 안다).
- 돌아가며 제시어를 설명한다.
- 누구든 **투표** 버튼을 누르면 전원 화면에 **O / X** 가 뜬다. 찬성이 **절반 이상**이면
  투표로 넘어간다(4명 중 2명 O 2명 X도 50%라서 진행).
- 지목된 사람이 라이어가 아니면 라이어 승. 라이어면 30초 안에 제시어를 맞혀야 역전승.

## 구조

```
web/room.js        게임 규칙과 상태 전부. I/O가 없어 테스트하기 쉽다
web/game-server.js WebSocket 서버 (웹·Electron 공용)
web/public/        화면 (브라우저·Electron 공용)
electron/peer.js   LAN 자동 발견 + 호스트 선출. Electron을 모른다
electron/main.js   창을 띄우고 위 둘을 이어 준다
logger.js          파일 로그 (회전 5MB, PID, 레벨)
```

**판정하는 주체는 언제나 서버 하나다.** 제시어도 서버만 알고, 라이어에게는 아예
전송되지 않는다. 상태가 바뀌면 각자에게 맞춘 전체 상태를 통째로 다시 보낸다 —
증분 이벤트를 쌓아 화면을 맞추지 않는다.

## 테스트

```bash
npm test
```

86건. 규칙 53건(가상 시계로 30초 대기 없이), 화면 17건(실제 Chromium 3개로 한 판),
자동 발견 9건(실제 프로세스 4개), Electron 브리지 7건.
화면 테스트는 Playwright가 없으면 건너뛴다.

## 배포용 exe

```bash
npm run dist       # dist/Slack.exe (Windows portable)
```

## 문서

- [docs/usage.md](docs/usage.md) — 사용법 (exe / 웹 / 모바일)
- [electron/README.md](electron/README.md) — Electron 구조, 호스트 선출, 프록시 주의
- [web/README.md](web/README.md) — 웹 버전 구조와 설계 원칙
- [docs/remaining-work.md](docs/remaining-work.md) — 남은 작업
- [docs/code-review.md](docs/code-review.md) — 초기 UDP P2P 버전 리뷰 (기록용)

`docs/code-review.md`가 다루는 UDP P2P 버전은 지금 서버 권위 방식으로 대체되어
저장소에서 빠졌다. 왜 그렇게 바꿨는지가 그 문서에 남아 있다.
