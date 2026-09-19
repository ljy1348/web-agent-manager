# Live preview·브라우저 증거

작성일: 2026-09-12

## 안전 경계

작업 보드의 preview는 관리자가 프로젝트별로 명시한 loopback HTTP(S) URL만 사용한다. `localhost`, `127.0.0.1`, `[::1]` 외 공인·사설망 host, URL credential, `file:` 등 다른 scheme은 저장 전에 거부한다. query와 fragment는 target 저장 시 제거한다.

브라우저 증거 캡처도 모든 HTTP(S)·WebSocket 요청을 loopback으로 제한하고 service worker를 끈다. 외부 origin 요청은 browser 단계에서 중단하며 원장에는 origin만 남긴다. 다음 정보는 저장하지 않는다.

- request/response header와 body
- cookie, local/session storage
- URL query와 fragment
- console의 credential 원문

console은 level과 최대 500자의 redacted text 100개, network는 origin+path·method·resource type·status·duration 300개까지만 저장한다. screenshot은 현재 viewport만 PNG로 저장하며 dataDir의 `workbench-artifacts/<task-id-hash>/`에 0600으로 둔다. DB와 task event에는 SHA-256·크기·viewport·정제된 console/network만 연결한다. 다운로드 때 root 경계, 일반 파일, SHA-256을 다시 확인한다.

task ID는 파일 경로로 직접 사용하지 않고 SHA-256 파생 디렉터리로 분리한다. 같은 task의 중복 capture는 거부하며 서버 전체에서 동시에 실행하는 Chrome은 2개로 제한해 API 반복 호출이 호스트를 고갈시키지 않게 한다.

console redaction은 알려진 credential 형식과 URL query를 대상으로 한다. 화면에 실제로 렌더링된 비밀이나 일반 문장 형태의 임의 비밀까지 screenshot에서 지우지는 못하므로, 캡처 전 테스트 fixture를 사용하고 결과는 관리자 전용 민감 artifact로 취급한다. iframe은 브라우저에서 보는 sandbox 화면이며, 엄격한 외부 요청 차단과 증거 수집은 서버 headless capture에 적용된다.

## 설정과 사용

작업 탭에서 task 카드의 `Live preview·브라우저 증거`를 펼친다.

1. 앱의 loopback URL과 320~1920 × 240~1080 viewport를 입력한다.
2. `Target 저장`을 누른다. 프로젝트의 다른 task도 같은 target을 사용한다.
3. sandbox iframe에서 현재 앱을 확인한다.
4. `증거 캡처`를 누르면 별도 headless Chrome이 같은 viewport로 screenshot·console·network를 수집한다.
5. 결과 이미지와 수집 개수·소요 시간·정제된 console을 확인한다.

각 capture에는 같은 문서에서 실행한 제한된 접근성 결과가 포함된다. 기준선 지정과 시각 diff는 [시각 회귀·접근성 검사](visual-regression-accessibility.md)를 따른다.

production host에서 Chrome 자동 발견이 되지 않으면 다른 사용자가 쓸 수 없는 최종 실행 파일을 지정한다. `/usr/bin/google-chrome` 같은 정상 symlink는 realpath 최종 파일을 검증한다.

```text
WEB_AGENT_MANAGER_PREVIEW_BROWSER_EXECUTABLE=/usr/bin/google-chrome
```

target 변경과 capture는 관리자·최근 재인증·신뢰 네트워크가 모두 필요하다. screenshot 조회도 관리자 전용이며 `test_only`는 target 조회 외 변경·capture를 할 수 없다.

## QA 기준

- 실제 loopback HTTP fixture와 설치 Chrome으로 지정 viewport PNG를 만든다.
- local fetch는 query 없는 network event와 status로 남고 외부 fetch는 차단된다.
- target/console/network/task event에 URL query나 알려진 secret marker가 0건이어야 한다.
- artifact 변조 뒤 다운로드는 거부한다.
- 실제 Chrome 시작·navigation·300ms 안정화·capture는 8초 상한을 둔다.
- UI의 350ms capture 지연에서 500ms 안에 disabled/진행 표시가 나타나고, 390px 화면 전체 overflow가 없어야 한다.
- 같은 viewport 기준선과 새 capture의 pixel diff 및 접근성 rule을 실제 Chrome으로 검증한다.
