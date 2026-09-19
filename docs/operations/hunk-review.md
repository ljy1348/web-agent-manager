# Hunk 결정·라인 주석 재전송

작성일: 2026-09-12

## 동작 경계

GitHub → 로컬에서 변경 파일을 선택하면 기존 HEAD 전체 diff 아래에 `미결정 hunk 검토`가 나타난다. 이 검토면은 index와 worktree 사이의 아직 stage되지 않은 text diff만 정본으로 쓴다.

- `승인·stage`: 선택한 hunk만 Git index에 적용한다. worktree 내용은 유지하며 이 명시적 버튼 클릭 자체를 승인으로 사용한다.
- `거부·되돌림`: 선택한 hunk만 worktree에서 역적용한다. 커밋하지 않은 해당 내용은 복구할 수 없다.
- binary, rename/copy, mode-only 변경은 부분 결정하지 않는다.
- 한 번에 1~50개 파일, 합계 5MiB까지만 직렬로 읽어 Git 프로세스와 메모리를 제한한다.

서버는 화면에 내려준 파일 patch SHA-256과 hunk SHA-256을 결정 요청에서 다시 요구한다. 그 사이 파일이 조금이라도 바뀌면 409로 거부하고 새로고침을 요구한다. 프로젝트·민감 경로·선택 worktree 경계를 다시 검증한 뒤 shell 없이 `git apply`에 patch stdin만 넘긴다.

결정은 관리자·최근 재인증·신뢰 네트워크가 모두 필요하며 `test_only` 계정은 실행할 수 없다. 성공 감사에는 파일 경로와 hash만 두고 diff 본문은 넣지 않는다.

## 라인 주석

검토 diff의 각 줄 오른쪽 `＋`를 눌러 의견을 작성하고 `현재 채팅에 재전송`한다. WAM은 파일·old/new side·줄 번호·hunk hash와 의견을 기존 채팅 prompt로 조립한다. 기존 prompt command 원장이 본문 hash·길이와 전달 상태만 보존하고, UI는 실패 재시도 동안 같은 `Idempotency-Key`를 유지하므로 같은 의견을 중복 입력하지 않는다.

라인 주석은 선택한 프로젝트 채팅이 있을 때만 보낼 수 있다. test-only 사용자는 일반 채팅 전송 자체가 차단된다.

## QA 기준

- 실제 임시 Git 저장소의 떨어진 hunk 두 개 중 하나만 stage하고 나머지 하나만 되돌린다.
- 승인 뒤 staged diff와 unstaged diff를 따로 확인하고, untracked text 승인도 worktree 원문을 유지한다.
- snapshot 이후 파일 변경은 409이며 index와 worktree를 추가 변경하지 않는다.
- 외부망과 test-only 결정 요청은 파일 적용 전에 403이다.
- 350ms 응답 지연에서 500ms 안에 처리/재전송 진행 상태가 보이고 요청은 각각 한 번이다.
- 390px viewport에서 문서 가로 overflow가 없어야 한다.
