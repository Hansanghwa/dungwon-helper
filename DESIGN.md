# 등원 도우미 (HomeCamera 프로젝트) — DESIGN.md
> DESIGN_PRINCIPLES.md (전역 base) 를 상속. 아래는 이 프로젝트의 pure-virtual 구현.

## Purpose            [pv]
아이 둘이 부모 없이 아침 등원 루틴(07:00 기상 → 08:32 등교)을 스스로 소화하도록,
집 패드용 알람+체크리스트 웹앱을 제공하고 체크 상태를 아빠 폰(S25)에 실시간 중계한다.

## Inputs / Outputs   [pv]
- Input: 아이들의 탭(체크/해제/SOS), 시계(스케줄 알람 트리거), 설정(localStorage)
- Output:
  - ntfy.sh 푸시 (아빠 폰 ntfy 앱) — 사람이 읽는 알림
  - ntfy.sh 이벤트 로그 토픽 — 기기 간 상태 동기화용 기계 이벤트(JSON)
  - 화면 UI (패드 = 아이 모드, 아빠 폰 브라우저 = 부모 모드)

## Scale Assumptions  [pv]
- 사용자 4명(아이 2 + 부모 2), 이벤트 하루 ~30건, 스테이지 ~8개.
- 데이터 규모가 극소라 §2(Memory)·§3(Speed) 예산은 사실상 해당 없음 — 병목은 네트워크 왕복 1건뿐.
- 인프라: 정적 호스팅(GitHub Pages) + ntfy.sh 무료 공용 서버 (메시지 캐시 12h → 하루 상태 재구성에 충분).

## Pipeline           [pv]
탭/시계 이벤트 → 로컬 상태 갱신(낙관적) → ntfy 발행(log 토픽 JSON + 푸시 토픽 사람용)
→ 타 기기 SSE 수신 → 이벤트 재생(replay)으로 상태 재구성 → 렌더
- 실패 시: 발행 실패해도 로컬 상태는 유지(localStorage), 재접속 시 `since=18h` poll 로 따라잡음.
- 이벤트 로그(ntfy 캐시)가 ground truth, 화면은 그 view (§1.2, §6).

## Domain Model       [pv]
- `Stage` (시간·라벨·체크 가능 여부) — 설정에서 편집 가능한 **데이터** (§1.1: 스케줄 변경 = 코드 수정 아님.
  2027-03 출근시간 변경 대비 핵심 요구)
- `Event` {type: check|uncheck|sos, kid, stage, date, ts} — 불변 (§1.6), 상태는 이벤트 재생 결과
- 체크 상태 key: `date|kid|stage` (자정 지나면 자연 리셋)

## Extension Points   [pv]
- 새 스테이지/시간 변경 → 설정 UI (코드 0줄)
- 새 이벤트 타입 → `EVENT_HANDLERS` 레지스트리에 핸들러 등록 (§1.4)
- 다른 푸시 백엔드(자가 ntfy 서버 등) → 설정의 서버 URL 교체

## Memory Budget      [pv]
해당 없음 — 하루 이벤트 수십 건, 전부 KB 단위. 측정 불요 (§2.3 의 "작고 뜨거운" 쪽만 존재).

## Performance Budget [pv]
- 체크 탭 → 타 기기 반영: ntfy 왕복에 종속 (통상 1초 미만, 우리 코드 병목 없음)
- 알람 정시성: 1초 tick 폴링 → 최대 1초 오차 (요구 수준 충족)

## Worker 산정         [pv]
해당 없음 — 브라우저 단일 스레드 이벤트 루프.

## ADR (§8 형식)
### ADR-001: 백엔드 없는 정적 페이지 + ntfy.sh
- Context: 아빠가 회사에서 실시간 확인 + 폰 푸시 필요. 가정용이라 서버 운영 부담 최소화가 우선.
- Decision: GitHub Pages(정적) + ntfy.sh 공용 서버(발행/SSE 구독/12h 캐시 replay)로 상태 동기화.
- Trade-off: 영속 저장 없음(자정 리셋이라 무관), ntfy.sh 가용성에 의존(장애 시 로컬 동작은 유지).
  Maintainability·운영단순성을 위해 확장성(주간 통계 등)을 양보 — 필요해지면 Firebase 로 이행.

### ADR-002: 토픽 이름을 저장소에 하드코딩하지 않음
- Context: GitHub Pages 는 public repo → repo 에 적힌 토픽은 누구나 구독/발행 가능.
- Decision: 토픽은 각 기기 최초 설정 시 입력(localStorage) + `?topic=` URL 파라미터로 전달.
- Trade-off: 기기마다 1회 수동 입력 필요.

## Out of Scope
- 주간 통계/리포트, 계정/인증, 오프라인 PWA(service worker), 홈캠 스트리밍(Tapo 앱이 담당),
  음성통화(iPhone 11 카카오톡이 담당). 지금은 안 한다.
