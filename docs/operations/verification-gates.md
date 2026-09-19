# Task verification gate

작성일: 2026-09-12

검증은 task가 시작할 때 고정한 project profile snapshot의 `verification.steps`만 사용한다. API 요청이 임의 명령을 전달할 수 없으며, 각 자동 단계는 argv 배열을 `shell:false`로 실행한다.

```text
POST /api/tasks/:taskId/verifications   Idempotency-Key: <unique key>
GET  /api/tasks/:taskId/verifications
GET  /api/chats/:chatId/current-task
POST /api/verifications/:runId/rerun    Idempotency-Key: <unique key>
```

실행은 관리자만 요청할 수 있다. 같은 task와 멱등 키를 다시 보내면 기존 run을 반환하고 명령을 다시 실행하지 않는다. artifact 기본 보존 기간은 30일이며 `WEB_AGENT_MANAGER_VERIFICATION_ARTIFACT_RETENTION_DAYS`로 조정한다.

각 step은 선택적으로 project-relative glob인 `includePaths`와 `excludePaths`를 가질 수 있다. `includePaths` 중 하나와 일치하고 `excludePaths`에는 일치하지 않는 변경 파일이 있을 때만 그 step을 선택한다. 조건 없는 step은 항상 선택한다. 선택한 ordinal과 조건부 필수 step을 생략한 사유는 `summary_json.selection`과 `verification.recipe_selected` task event에 남기지만 변경 파일명 원문은 복제하지 않는다. 조건부 step만 있는 recipe에서 모두 생략되거나 Git이 변경 파일 목록을 제공하지 못하면 검증 없이 완료하지 않고 `needs_input`으로 차단한다.

지원 단계:

- 자동 실행: `static`, `focused_test`, `full_test`, `build`, `ui`, `contract`
- 최초 자동 실행 금지: `live`, `human_review`

recipe가 없거나 자동 실행 금지 단계가 포함되면 run은 `blocked`, task는 `needs_input`이 된다. 관리자는 `POST /api/verifications/:runId/decision`에 새 멱등 키와 `approve|decline`을 보내 결정한다. 승인 전후 commit/diff hash가 같을 때만 live argv를 실행하며 human review는 명령 없이 승인 증거 step을 남긴다. 필수 단계가 하나라도 실패하거나 timeout이면 run과 task는 `failed`가 되며, 모든 필수 단계가 통과했을 때만 task가 `completed`로 전환된다. shell 연산자가 포함된 문자열 command는 거부하며 새 profile은 명시적인 `argv`를 저장한다. 자식 프로세스에는 PATH/HOME/locale 등 최소 환경만 전달하고 timeout 후 SIGTERM, 2초 뒤 SIGKILL을 적용한다.

stdout/stderr는 단계별 최대 1 MiB로 제한해 `data/verification-artifacts/<run>/<step>.log`에 0600으로 보존한다. Bearer 인증, JWT, 알려진 credential, cookie, secret/token/password/key 환경변수 값과 설치 계정 홈 경로를 제거한 뒤 SHA-256·크기·redaction 상태를 DB에 기록한다. private key처럼 격리가 필요한 출력은 치환 후 `verification-artifacts-quarantine`에 보존하고 단계와 run을 blocked로 만들어 완료를 막는다.

검증 시작 시 Git HEAD와 HEAD 대비 binary diff, porcelain status, untracked 파일 blob hash를 합성해 `commit_hash`와 `diff_hash`를 고정한다. Git snapshot을 만들 수 없으면 검증 명령을 실행하지 않고 `workspace_snapshot_failed`로 차단한다. 서버 재시작 때 남은 pending/running run도 자동 재실행하지 않고 `server_restart_reconciliation_required`로 차단한다.

명시적 재검증은 원본 run ID를 URL에 넣어 요청한다. 원본이 종료 상태이고 현재 task의 불변 profile version, Git commit, diff hash가 모두 원본과 같을 때만 `trigger=reverification`과 `source_run_id`가 있는 새 run을 만든다. 같은 멱등 키 재요청은 이 새 run을 반환하며 recipe를 다시 실행하지 않는다. commit이나 diff가 달라졌다면 일반 검증의 새 멱등 키를 사용해야 한다.

검증 실행 요청의 JSON body에 양의 정수 `pullRequestNumber`를 넣으면 로컬 필수 단계 통과 뒤 `gh pr view --json number,headRefOid,statusCheckRollup`으로 PR head와 check rollup을 읽어 같은 gate에 연결한다. GitHub에는 check 생성·수정·댓글 같은 쓰기를 하지 않는다. 현재 workspace가 clean이고 PR head SHA가 고정한 local commit과 같으며 모든 check가 success/neutral/skipped일 때만 통과한다. 실패 check는 run/task 실패, pending·빈 check·알 수 없는 상태·조회 실패·head 불일치·dirty workspace는 `needs_input` 차단이다. profile의 `verification.pullRequestChecks.required=true`이면 PR 번호 없는 실행도 차단한다. 재검증은 원본 PR 번호를 계승하고 최신 check를 다시 읽는다. 원장과 UI에는 PR 번호, head SHA, 성공·실패·대기·확인 불가 개수만 남기며 check 이름·URL·본문은 복제하지 않는다.

채팅 모드의 접이식 검증 패널은 최신 task의 고정 profile version, task/run 상태, commit/diff hash, 선택·생략 단계, 재검증 원본, PR 집계와 artifact hash를 보여준다. 일반 사용자는 이 요약만 읽을 수 있고 관리자는 최초 실행, 동일 변경 재검증, live/human 승인·거부와 safe artifact 다운로드를 사용할 수 있다. 조회 응답에서도 내부 argv, cwd, artifact 절대 경로와 멱등 키는 제외한다.

timeline 조회는 run별 N+1 쿼리 대신 run·step·artifact를 각각 한 번씩 배치 조회한다. 채팅 패널은 최신 20회와 이전 기록 존재 여부만 받고, task timeline API의 `limit`은 기본·최대 100이다. 패널은 최초 조회가 늦을 때 로딩 상태를 즉시 표시하고 실행 요청 중 버튼을 잠가 중복 제출을 막는다. 성능 회귀 QA는 실제 임시 SQLite에 300 run·2,400 step/artifact를 넣어 직접 최신 task 조회 500ms 미만, 100 run HTTP 조회 1.5초 미만, 최신 task HTTP 조회 1초 미만을 요구한다. 이 상한은 공유 CI 변동을 허용하면서 N+1이나 무제한 응답 같은 큰 회귀를 잡는 기준이다.

관리자 artifact 다운로드는 `GET /api/verification-artifacts/:artifactId`를 사용한다. DB의 redaction 상태가 safe이고, 파일이 verification artifact root 내부에 있으며, 현재 파일 SHA-256이 원장과 일치할 때만 제공한다.

만료 cleanup은 DB가 가리키는 두 관리 root 내부 파일만 지우며 경로 이탈 행은 건너뛴다.
