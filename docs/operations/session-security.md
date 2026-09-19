# 로그인·세션 보안 운영 절차

WAM의 비밀번호 로그인 제한은 원문 IP와 아이디를 저장하지 않고 SHA-256 bucket으로 SQLite에 보존한다. 한 IP에서 여러 계정을 시도하는 공격과 여러 IP에서 한 계정을 시도하는 공격을 각각 제한하며, 서버를 다시 시작해도 현재 잠금과 감사 중복 방지 상태가 이어진다. 만료되고 잠기지 않은 bucket은 24시간 뒤 정리되고 scope별 최대 10,000개만 유지한다.

## 사용자 조치

설정의 `로그인 보안` 카드에서 최근 활성 세션을 확인한다. 현재 세션은 목록의 맨 위에 고정되며 최대 100개를 표시한다. `다른 세션 로그아웃`은 현재 세션을 보존하고 같은 계정의 나머지 세션을 즉시 삭제한다. 비밀번호 변경은 현재 비밀번호를 다시 확인하고 성공하면 새 비밀번호를 scrypt로 저장한 뒤 현재 세션을 포함한 모든 세션을 삭제하므로 다시 로그인해야 한다.

일회용 임시 로그인은 세션 목록만 볼 수 있고 세션 폐기와 비밀번호 변경을 수행할 수 없다. `test_only` 자격증명은 자기 계정의 세션·비밀번호만 관리할 수 있으며, 이 동작은 canary·verification 외 운영 기능 권한을 추가하지 않는다.

## TOTP 2단계 인증

설정의 `2단계 인증`에서 현재 비밀번호를 다시 입력하면 10분 동안 유효한 수동 등록 키를 한 번 표시한다. 표준 인증 앱에 키를 등록하고 앱의 6자리 코드를 확인해야 활성화된다. 등록 완료 때 표시되는 복구 코드 10개는 각각 한 번만 쓸 수 있으며 WAM에는 SHA-256만 남으므로 별도 안전한 장소에 보관해야 한다.

MFA가 활성화된 계정은 올바른 비밀번호만으로 웹 세션을 받지 못한다. 5분짜리 계정별 pending challenge에 TOTP 또는 복구 코드를 제출한 뒤에만 HttpOnly cookie가 발급된다. 사용한 TOTP time-step과 복구 코드는 재사용할 수 없고, 새 challenge를 발급해도 계정 전체 실패 제한은 초기화되지 않는다. MFA 해제는 현재 비밀번호와 두 번째 요소를 모두 요구하며 성공하면 모든 세션을 폐기한다.

TOTP seed는 `dataDir/secrets/mfa-master.key`의 32-byte 소유자 전용 key로 AES-256-GCM 암호화된다. key 파일이나 디렉터리가 symlink·과도한 권한·잘못된 크기이면 거부하며, 등록 데이터가 있는데 key가 없거나 맞지 않으면 인증 라우터 기동이 실패한다. 이 파일을 임의로 재생성하면 기존 MFA를 복구할 수 없다.

## 열린 연결 폐기

WebSocket은 메시지를 처리할 때마다 세션 행, 사용자 role·access scope, 모바일 신뢰 기기 연결과 활성 상태를 다시 확인한다. 메시지가 없어도 기본 1초 주기로 확인한다. 세션 삭제, role/scope 변경, 기기 해제 또는 비활성화가 발견되면 기존 연결을 종료하고 해당 메시지는 처리하지 않는다. 비밀번호 변경 뒤 열린 터미널 입력 연결도 이 경로로 폐기된다.

## 유휴 만료와 중요 작업 재인증

절대 세션 TTL과 별도로 최근 HTTP 또는 WebSocket 활동이 `WEB_AGENT_MANAGER_SESSION_IDLE_MINUTES`(기본 720분)를 넘으면 인증에서 제외하고 세션 행을 정리한다. 허용 범위는 5~10,080분이다. WebSocket 활동은 idle 시간의 절반 또는 최대 5분 간격으로 DB에 반영해 쓰기 부하와 오탐을 함께 줄인다.

새 비밀번호+MFA 로그인의 재인증은 `WEB_AGENT_MANAGER_REAUTH_WINDOW_MINUTES`(기본 15분, 1~60분) 동안 유효하다. 모바일 기기 서명과 일회용 임시 로그인은 이 창을 자동으로 열지 않는다. 창이 지난 뒤 모든 DELETE, 공급자 rollout/update/rollback, 프로세스 종료, CLI·agent account·MCP 변경, Git discard/push, PR close/merge를 실행하면 서버가 mutation handler 전에 `reauthRequired`로 거부한다. 설정의 `중요 작업 본인 확인`에서 현재 비밀번호와, MFA 사용 계정은 TOTP 또는 복구 코드를 입력한 뒤 원래 작업을 다시 실행한다.

## HTTPS·proxy 기동 진단

production에서 외부 hostname/public IP의 `PUBLIC_URL`이 HTTP이면 서버는 `external_http_blocked`로 시작하지 않는다. 장애 복구 중 정말 필요한 경우에만 `WEB_AGENT_MANAGER_ALLOW_INSECURE_HTTP=1`로 명시 우회할 수 있지만 관리자 대시보드 경고는 계속 남고 전송은 암호화되지 않는다. loopback 개발 HTTP는 허용하며 production 사설망 HTTP, wildcard `PUBLIC_URL`, HTTPS인데 trusted proxy가 없는 구성은 서버 로그와 대시보드에 조치 문구를 표시한다.

`PUBLIC_URL`은 자격증명·경로·query가 없는 단일 http(s) origin이어야 한다. HTTPS일 때만 로그인 cookie의 Secure 속성과 HSTS가 함께 켜진다. WAM HTTP 서버 앞에서 TLS를 끝내는 proxy의 주소는 넓은 대역이 아니라 정확한 `WEB_AGENT_MANAGER_TRUSTED_PROXIES` CIDR로 등록한다.

## 점검

운영 DB나 실제 계정을 복제하지 않고 다음 회귀 검사를 실행한다.

```bash
npx vitest run tests/login-rate-limit.test.ts tests/auth-routes.test.ts tests/mfa.test.ts tests/realtime-heartbeat.test.ts tests/mobile-device-trust.test.ts
npx playwright test tests/e2e/ui.spec.ts --grep "MFA 계정|세션 폐기와 비밀번호 변경"
```

테스트는 임시 SQLite·HTTP 서버·WebSocket과 API mock만 사용한다. 대량 세션 목록의 HTTP 응답은 1,001개 fixture에서 500ms 미만, 버튼의 진행 상태는 브라우저 내부 기준 500ms 미만을 회귀 상한으로 둔다.
