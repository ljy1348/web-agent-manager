# 테스트 전용 자격증명

## 생성

테스트 계정은 웹 가입이나 관리자 비밀번호 공유로 만들지 않는다. 새 서버가 migration을 완료한 뒤, production build와 owner-only 비밀번호 파일로 생성한다. CLI는 `users.access_scope`가 없는 구버전 DB를 자동 migration하지 않고 종료한다.

```bash
export WEB_AGENT_MANAGER_TEST_USERNAME='qa-tester'
export WEB_AGENT_MANAGER_TEST_PASSWORD_FILE='/secure/outside-workspace/wam-test-password'
npm run tester:create
unset WEB_AGENT_MANAGER_TEST_PASSWORD_FILE
```

비밀번호 파일은 absolute path의 symlink가 아닌 현재 실행 사용자 소유 0600 일반 파일이어야 한다. 마지막 개행 하나 외의 줄바꿈과 NUL은 거부한다. 직접 값인 `WEB_AGENT_MANAGER_TEST_PASSWORD`도 하위 호환으로 지원하지만 파일 변수와 동시에 설정하면 실패한다. 개발 소스에서 실행할 때는 `npm run tester:create:dev`를 사용한다. 같은 이름의 기존 `test_only` 계정은 비밀번호만 갱신한다. 기존 관리자, 일반 사용자, 일회용 임시 계정은 tester로 변경하지 않고 오류를 반환한다.

## 권한 경계

DB의 `role`은 `user`, `access_scope`는 `test_only`다. 따라서 기존 `requireAdmin` 경로를 통과하지 못하며, 전역 API middleware가 GET/HEAD/OPTIONS를 제외한 모든 변경 요청을 기본 거부한다.

명시적으로 허용하는 변경 API는 다음 세 종류뿐이다.

- `POST /api/providers/:provider/canaries`
- `POST /api/tasks/:taskId/verifications`
- `POST /api/verifications/:runId/rerun`

특히 다음은 허용하지 않는다.

- 실제 CLI 업데이트와 터미널 재시작
- 채팅 생성·입력·중지·interrupt·모드 변경
- 프로젝트·파일·Git/GitHub 변경
- live/human verification 승인과 artifact 다운로드
- 공급자 승인 요청 결정
- 계정·CLI 인증·알림·사용량·프로세스·예약·도구 설정 변경

웹에서는 `테스트 전용` 배지를 표시하고, 프로젝트 선택·추가·삭제와 채팅 composer를 비활성/숨김 처리한다. canary 실행 및 일반 verification 실행·재검증 UI만 추가로 노출한다. 관리자의 update/프로세스/live 승인 UI는 노출하지 않는다.

## 보안 주의

- tester도 기존 일반 사용자와 같은 읽기 화면을 볼 수 있으므로 신뢰된 QA 담당자에게만 발급한다.
- 운영 관리자와 비밀번호를 공유하지 않는다.
- 테스트가 끝나면 별도 사용자 관리 절차로 계정을 폐기하거나 비밀번호를 회전한다.
- canary 후보 harness가 준비되지 않은 환경에서는 tester 실행도 `blocked`가 정상이며 실제 CLI를 업데이트하지 않는다.

## QA 기준선

2026-09-13 기준 임시 SQLite에서 scrypt 계정 생성·비밀번호 회전·로그인 session scope와 기존 계정 강등 거부를 검증했다. 실제 로컬 HTTP 권한표는 허용된 세 POST와 GET만 통과하고, project profile·structured shadow probe를 포함한 운영 mutation은 service 진입 전에 동일한 403으로 거부되며 전체 요청 묶음은 2초 상한을 적용한다. 실제 Chrome에서는 350ms 응답 지연에도 canary·verification 진행 상태가 500ms 안에 표시되고, 운영 제어 미노출과 390px 무overflow를 확인한다. 이 자동 QA는 운영 DB에 실제 tester를 만들거나 유료 공급자 credential을 사용하지 않는다.
