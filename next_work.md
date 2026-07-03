# next_work.md — 등원 도우미

## 완료 (2026-07-03)
- 결정: 홈캠 = iPhone 11 + AlfredCamera (0원), 호스팅 = GitHub Pages + ntfy.sh
- DESIGN.md (§10 슬롯) + 웹앱 (index.html / style.css / app.js) + README 작성, 초기 커밋 완료
- JS 문법 검증 완료 (JavaScriptCore parse-check). **실기기 런타임 테스트는 아직 안 함**

## 다음 할 일
1. ~~GitHub 배포~~ ✅ 완료 (2026-07-03): https://hansanghwa.github.io/dungwon-helper/
   (repo: https://github.com/Hansanghwa/dungwon-helper, Pages 라이브 확인됨 — HTML/JS/CSS 전부 200)
   ⚠️ shhan2 는 **회사 계정** — 개인 프로젝트 업로드 금지. 처음 올렸다가 삭제하고 Hansanghwa 로 재배포함.
2. 실기기 테스트: 패드에서 알람 소리·음성·체크 → S25 ntfy 푸시 수신 확인
3. iPad Safari 특이사항 확인: 백그라운드 탭에서 setInterval 이 멈추면 알람 유실 가능
   → 전체화면(홈 화면 추가) + 자동잠금 해제로 회피, 실사용으로 검증 필요
4. Tapo 카메라 설치 (구매 완료 — 보안 3수칙 포함, README ③) + iPhone 11 카카오톡 전화기 설정 (README ②)
5. git 커밋 author 가 자동 설정됨 (Eunjoo Cho <EunjooCho@Macmini.local>) — 원하면 수정

## 메모
- 가족 채널 이름(ntfy 토픽)은 repo 에 하드코딩 안 함 (public repo 라서, DESIGN.md ADR-002)
- ntfy.sh 캐시 12h → 자정 리셋 구조라 영속 저장 불필요. 주간 통계 원하면 Firebase 이행 (ADR-001)
