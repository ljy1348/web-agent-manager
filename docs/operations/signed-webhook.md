# Signed outbound webhook 운영 절차

## 목적과 payload

특정 SaaS token을 WAM에 무조건 추가하지 않고, 등록 프로젝트의 CI·incident·사내 자동화가 공통으로 받을 수 있는 outbound 채널이다. 활성화하면 기존 운영 알림과 같은 이벤트를 다음 고정 JSON으로 전송한다.

```json
{"eventId":"…","type":"task_completed","title":"…","text":"…","timestamp":"2026-09-13T00:00:00.000Z"}
```

임의 header·body template은 지원하지 않는다. event ID/type/title/text는 각각 200/64/200/4,000자로 제한되고, 같은 event ID의 성공 전송은 다시 보내지 않는다.

## 등록과 검증

1. 내부망 또는 등록된 신뢰 기기에서 관리자 계정으로 로그인한다.
2. 설정의 `중요 작업 본인 확인`을 완료한다.
3. `Signed outbound webhook`에 fragment·내장 계정정보가 없는 HTTPS endpoint와 32 byte 이상의 무작위 HMAC secret을 입력하고 활성화한다.
4. 저장 직후 입력은 비워지고 hostname만 표시되는지 확인한다.
5. 수신기에서 `X-WAM-Timestamp`와 body를 점(`.`)으로 연결한 bytes의 HMAC-SHA256을 계산해 `X-WAM-Signature: sha256=<hex>`와 timing-safe 방식으로 비교한다. timestamp 허용 오차와 event ID replay cache도 수신기에서 적용한다.
6. `테스트 전송`으로 `type=test` 이벤트 한 건을 검증한다.

Endpoint 전체(path/query 포함)와 signing secret은 AES-256-GCM credential vault에 별도로 저장된다. API·UI·감사·delivery 원장에는 endpoint hostname, 설정 여부, HTTP 상태와 제한된 오류 코드만 남는다.

## 네트워크·장애 계약

- HTTPS만 허용하며 DNS 결과가 하나라도 loopback/private/link-local/multicast/documentation 대역이면 전송하지 않는다.
- 검사를 통과한 공개 IP 하나를 실제 TLS lookup에 고정해 검사 뒤 DNS 재해석을 막는다. 원래 hostname의 TLS SNI/인증서 검증은 그대로 유지한다.
- redirect는 따르지 않고 3xx를 실패로 기록한다. 전체 요청 timeout은 10초다.
- 전송 실패는 다른 Slack/ntfy/FCM 채널을 막지 않는다. 같은 event의 실패 행은 다음 명시 호출에서만 제한적으로 재시도되고, sending/sent 중복 호출은 전송하지 않는다.
- 설정·테스트는 관리자, 최근 재인증, 신뢰 네트워크가 모두 필요하다. `test_only` 자격증명은 안전한 verification/canary만 실행할 수 있으므로 webhook 설정이나 외부 전송을 할 수 없다.
