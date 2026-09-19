# 시각 회귀·접근성 검사

작성일: 2026-09-12

## 사용 흐름

1. 작업 카드의 Live preview에서 `증거 캡처`를 실행한다.
2. 결과가 기준 화면이면 `현재 화면을 기준선으로`를 누른다.
3. 앱 변경 뒤 `시각·접근성 검사`를 누른다.
4. 변경 픽셀 수/전체 픽셀/비율과 visual diff PNG, 접근성 위반 node·rule 수를 확인한다.

기준선은 같은 task의 `preview_screenshot`만 지정할 수 있다. 새 캡처의 PNG width/height가 다르면 임의 resize하지 않고 `viewport_size_mismatch`로 비교 불가를 기록한다.

## 산출물과 개인정보 경계

동일 크기 PNG는 `pixelmatch` threshold 0.1, anti-alias 제외로 비교한다. 0 pixel도 검증 결과이며 diff PNG는 `visual_diff` 종류의 0600 파일로 저장한다. baseline/current/diff artifact SHA-256과 viewport·변경 픽셀 수/비율을 append-only task event에 연결하고 다운로드 때 기존 root·regular-file·hash 검증을 다시 적용한다.

접근성 검사는 같은 실제 Chrome 문서에서 외부 요청 없이 주입한 `axe-core`로 실행한다. 저장 범위는 최대 100개 위반 rule의 다음 항목뿐이다.

- rule ID, impact, 정적 help
- rule별 위반 node 수
- node당 최대 3개, rule당 최대 15개의 제한·redacted selector
- 전체 위반 node/rule, pass, incomplete 수

DOM HTML/text, form value, cookie/storage, request/response 본문은 저장하지 않는다. 다만 screenshot 자체에는 렌더링된 민감정보가 보일 수 있으므로 관리자 전용 민감 artifact로 취급한다.

기준선 지정과 검사는 관리자·최근 재인증·신뢰 네트워크가 모두 필요하고 `test_only` 계정은 실행할 수 없다. 접근성 위반은 관찰 증거이며 자동으로 파일을 수정하거나 검증을 승인하지 않는다.

## QA 기준

- 같은 320×240 fixture는 0 pixel, 색상을 바꾼 fixture는 50,000 pixel·50% 이상 차이를 검출한다.
- 의도적인 빈 button, lang 없는 html, alt 없는 image의 `button-name`, `html-has-lang`, `image-alt`를 검출한다.
- form value와 HTML 원문은 artifact metadata/task event에 0건이다.
- preview 전용 기존 SQLite table을 열어 기존 행 보존·`visual_diff` 추가·foreign key 무결성을 확인한다.
- 실제 변경 검사 1회는 10초 이내, 350ms API 지연은 UI에서 500ms 이내 진행 상태를 표시한다.
- 390px viewport에서 current/diff 이미지와 통계가 문서 가로 overflow를 만들지 않는다.
