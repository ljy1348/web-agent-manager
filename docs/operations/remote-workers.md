# 원격 worker·SSH host

작성일: 2026-09-13

## 현재 지원 범위

설정의 `원격 worker · SSH host` 카드는 관리자가 명시적으로 등록한 host의 worker protocol·version·허용 capability와 연결 지연을 확인한다. host별 workspace root 아래에 프로젝트 remote path를 연결하고, 작업 카드에서 관리자가 명시 확인한 `build|test|verify|preview` capability를 원격 worker에 접수한 뒤 상태를 갱신할 수 있다. probe 성공만으로 자동 실행하지 않는다.

## 안전 경계

- hostname/IP, port, username과 comment 없는 Ed25519/ECDSA host public key를 관리자가 직접 등록한다. TOFU는 사용하지 않는다.
- private key는 credential vault에 AES-256-GCM으로 저장한다. API·감사·설정 화면에는 key 원문이나 vault 식별자를 반환하지 않는다.
- probe마다 0700 임시 디렉터리와 0600 identity/known_hosts를 만들고 끝나면 지운다.
- SSH는 `BatchMode`, `IdentitiesOnly`, strict host-key check를 강제하고 password, keyboard-interactive, agent forwarding, port forwarding, local command를 모두 끈다.
- 원격 명령은 `web-agent-manager-worker capabilities --json`, `tasks start --protocol wam-worker/v1 --request-base64 <제한 JSON>`, `tasks status --protocol wam-worker/v1 --dispatch-id <검증 ID>`로 고정한다. 제한 JSON에는 request/task ID, 고정 capability, 승인된 project path만 있고 사용자 입력 command·prompt·env·credential은 없다.
- 응답은 64KiB, 10초로 제한하며 protocol은 `wam-worker/v1`, capability는 `build`, `test`, `verify`, `preview`, `artifact-read`만 인정한다.
- 같은 host의 probe/dispatch/status 중복은 거부하고 서버 전체 동시 SSH 작업은 4개로 제한한다.
- 등록·수정·probe·mapping·dispatch·status·삭제는 관리자, 최근 재인증, 신뢰 네트워크가 모두 필요하다. `test_only` 자격증명에는 조회나 변경을 허용하지 않는다.

## 등록과 probe

1. 설정의 로그인 보안 카드에서 중요 작업 본인 확인을 한다.
2. worker 이름, host, port, 전용 OS username, `/` 자체가 아닌 absolute POSIX workspace root, 서버에서 미리 확인한 host public key와 전용 private key를 입력한다.
3. `Worker 등록`을 누른 뒤 화면에 fingerprint만 남고 private key 입력이 비워졌는지 확인한다.
4. 표시된 fingerprint를 별도 신뢰 경로로 얻은 값과 대조한다.
5. `연결 Probe`를 눌러 `준비됨`, `wam-worker/v1`, worker version, 허용 capability와 왕복 시간을 확인한다.
6. key를 바꿀 때는 `편집·key 회전`에서 새 key만 입력하고 저장한 뒤 다시 probe한다.

## 프로젝트 mapping과 dispatch

1. 설정에서 프로젝트, 준비된 worker, workspace root 자체 또는 그 하위의 정규화된 remote project path를 선택해 mapping을 저장한다. `..`, 이중 separator, root 밖 경로는 거부된다.
2. 작업 보드의 `Remote worker dispatch`를 펼치면 mapping과 probe에서 실제 선언한 실행 capability만 표시된다.
3. capability를 고르고 `확인 후 원격 실행`을 누른 뒤 host/path/action 확인창을 승인한다.
4. WAM은 task별 `Idempotency-Key`를 원장에 먼저 기록한다. 응답을 잃으면 `unknown`으로 남기고 자동 재전송하지 않는다. 서버가 `dispatching` 중 재시작되어도 같은 상태로 한 번만 복구한다.
5. worker가 반환한 remote dispatch ID가 있을 때만 `상태 확인`을 실행한다. 완료/실패 상태는 추가 SSH 없이 그대로 보존된다.

저장소에는 SSH client·protocol·원장/UI와 실제 `web-agent-manager-worker` CLI가 포함돼 있다. CLI는 요청이 보낸 명령을 실행하지 않고 host 관리자가 owner-only 설정에 미리 적은 capability recipe만 실행한다. 실제 host 설치와 프로젝트별 recipe 승인은 별도 운영 배포이므로, 완료하기 전에는 해당 host dispatch를 시도하지 않는다.

## worker 설치와 recipe

1. 원격 host에 같은 릴리스의 `dist/server/scripts/web-agent-manager-worker.js`와 production dependency를 배포하고, `web-agent-manager-worker`라는 이름으로 전용 계정의 PATH에서 실행되게 한다. package의 `bin` 항목을 사용하는 설치도 같은 파일을 가리킨다.
2. [설정 예시](remote-worker-config.example.json)를 복사해 `/home/<worker>/.config/web-agent-manager/worker.json` 같은 전용 경로에 저장하고 파일을 `0600`으로 만든다. 다른 경로면 worker 계정에 `WEB_AGENT_MANAGER_WORKER_CONFIG`를 고정한다.
3. `workspaceRoot`는 `/`가 아닌 실제 프로젝트 상위 디렉터리, `stateDir`은 workspace 밖의 `0700` 전용 디렉터리로 둔다. 설정에 없는 capability는 probe에도 나타나지 않는다.
4. recipe의 executable은 PATH 이름이 아니라 absolute path이며 최종 realpath가 일반 실행 파일이고 group/world writable이 아니어야 한다. argv는 설정의 고정 배열 그대로 `shell: false`로 실행된다. 요청은 argv·환경변수·prompt를 바꿀 수 없다.
5. `test`, `verify`, `build`, `preview`는 각각 종료되는 명령만 등록한다. 장기 실행 preview server가 아니라 preview build/snapshot처럼 timeout 안에 끝나는 recipe를 사용한다.
6. 설치 뒤 전용 계정에서 `web-agent-manager-worker capabilities --json`을 실행하고 응답과 설정 capability가 같은지 확인한 다음 WAM probe를 수행한다.

worker는 start 전에 task 요청 exact schema, protocol, ID, capability, project realpath를 검사한다. symlink로 workspace 밖을 가리키는 project는 거부한다. state는 `0600` JSON에 원자 기록하고 start는 detached runner를 만든 뒤 즉시 `queued`를 반환한다. 같은 request ID와 같은 payload는 현재 상태를 반환하고 다른 payload 재사용은 거부한다. 동시성 상한은 queued/running 합계에 적용한다. runner가 사라지면 status에서 failed로 확정하며 자동 재실행하지 않는다. stdout/stderr는 64KiB, summary 400자로 제한·redact하고 private key 형식 출력은 결과를 실패 처리한다. 실행 환경은 `PATH`, `LANG`, `CI`만 전달하며 timeout에는 TERM 뒤 2초 후 KILL을 사용한다.

production에서 OpenSSH 위치를 바꿔야 할 때만 최종 실행 파일을 지정한다. symlink는 realpath의 최종 일반 파일을 검증하며 group/world writable 파일은 거부한다.

```text
WEB_AGENT_MANAGER_SSH_EXECUTABLE=/usr/bin/ssh
```

## 장애 확인

- `연결 실패`: DNS/route/firewall, worker 계정, private key 권한, pinned host key 변경, 5초 연결 제한을 확인한다.
- `비호환`: worker가 단일 JSON object로 `protocol`, `version`, `capabilities`를 반환하는지 확인한다.
- host key가 바뀌었다면 먼저 서버 교체 여부를 별도 경로에서 확인한다. 실패를 우회하려고 strict checking을 끄지 않는다.
- 저장한 private key는 다시 볼 수 없다. 회전할 새 key가 없으면 기존 값을 유지한다.

## QA 기준

- 실제 로컬 child process인 fake SSH로 고정 argv, 0600 identity/known_hosts, pinned key 내용과 고정 원격 command를 검사한다.
- timeout·비호환 JSON 뒤 상태와 probe slot이 정상 복구되어야 한다.
- workspace escape, undeclared capability, 동시 host 작업, 고정 start/status argv, 멱등 replay, ACK timeout `unknown`, 재시작 복구를 검사한다.
- DB/API/감사/UI에 private key marker가 0건이어야 하며 vault lease는 probe 뒤 released 상태여야 한다.
- 가짜 worker probe 전체 응답은 2초 상한 안에 끝나야 한다.
- UI의 350ms 등록/probe 지연에서 500ms 안에 disabled/진행 표시가 나타나고 요청은 각각 1회여야 한다.
- 390px 화면 전체에 가로 overflow가 없어야 한다.
- 작업 카드의 350ms dispatch/status 지연에서 500ms 안에 disabled/진행 표시가 나타나고 요청은 각각 1회여야 한다.
- 실제 worker CLI의 capabilities/start/status, detached 실행, 멱등 replay, state 0600, secret redaction을 검사하고 start ACK는 2초 안이어야 한다.
- exact request/config, config 0600, symlink root escape, request ID 충돌, 동시성 상한, timeout TERM/KILL과 shell 비사용을 실제 child process에서 검사한다.

실제 운영 host·운영 key를 자동 QA에 사용하지 않는다. 외부 배포 전에는 별도 격리된 test worker에서 수동 acceptance를 수행한다.
