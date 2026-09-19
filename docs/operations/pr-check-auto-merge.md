# PR check 모니터링·조건부 자동 merge

작성일: 2026-09-13

## 동작 범위

GitHub 탭에서 선택한 PR 하나만 15초마다 갱신해 head SHA, check 집계, review decision, conflict/mergeable 상태와 GitHub native auto-merge 예약 여부를 표시한다. PR 목록에는 check rollup을 넣지 않아 PR 수만큼 GraphQL 비용이 늘지 않는다. 브라우저 탭이 보이지 않거나 이전 조회가 끝나지 않았으면 다음 poll을 건너뛴다.

task verification의 PR check gate는 기존대로 별도 정본이다. 조건부 자동 merge 예약·취소가 현재 채팅의 task와 연결되면 check 이름·URL·본문 없이 PR 번호, head SHA, check 상태·개수만 task event에 추가한다.

## 예약 전 안전 조건

`조건부 자동 merge`는 다음 조건을 서버가 GitHub에서 다시 읽어 모두 만족할 때만 `gh pr merge --auto --match-head-commit <SHA>`를 실행한다.

- 요청 화면의 head SHA와 실행 직전 GitHub head SHA가 같다.
- PR이 open이고 draft가 아니다.
- GitHub가 `MERGEABLE`로 판정했고 conflict가 없다.
- `CHANGES_REQUESTED` review가 없다.
- check가 한 개 이상이며 failed·판정 불가 check가 0개다. pending check는 GitHub가 기다린다.
- method는 merge/squash/rebase 중 하나이며 임의 CLI 인자는 받지 않는다.

GitHub native auto-merge는 repository에서 기능이 켜져 있어야 하고, required review와 required status check가 모두 충족된 뒤 병합한다. merge queue가 있으면 GitHub의 queue 정책을 따른다. `--admin` 우회는 사용하지 않는다. 이미 모든 요구조건이 충족됐다면 예약 요청 자체가 즉시 병합할 수 있으므로 UI 확인 문구에 이를 명시한다.

예약과 취소는 관리자·최근 재인증·신뢰 네트워크와 명시 확인이 모두 필요하다. `test_only` 계정은 실행할 수 없다. 기존 즉시 병합도 신뢰 네트워크를 요구한다.

## 사용

1. GitHub → PR에서 대상 PR을 선택한다.
2. `check 진행 중/통과/실패/판정 불가`, 각 개수, head SHA, mergeable, review 상태를 확인한다.
3. 병합 방식과 브랜치 삭제 여부를 고른다.
4. `조건부 자동 merge`와 확인창을 누른다.
5. `조건부 자동 merge 예약됨`을 확인한다. 이후 요구 조건 충족과 실제 병합은 GitHub가 수행한다.
6. 아직 병합되지 않았다면 `자동 merge 취소`로 GitHub 예약만 해제할 수 있다.

## 실패 대응

- `head가 바뀌었습니다`: 새 commit이 push됐다. 최신 PR 상태와 check를 다시 검토한다.
- `check가 없어`: 보호 조건 없는 PR을 자동으로 즉시 합치는 사고를 막기 위한 WAM의 보수적 차단이다.
- `실패하거나 판정 불가`: GitHub에서 실패/unknown check를 해결한 뒤 재시도한다.
- `merge 가능 상태를 아직 확인할 수 없습니다`: 잠시 뒤 poll을 기다리거나 새로고침한다. UNKNOWN을 성공으로 가정하지 않는다.
- GitHub가 auto-merge 미지원/비활성 오류를 반환하면 repository 설정과 권한을 확인한다. WAM이 강제로 우회하지 않는다.

## QA 기준

- 실제 fake `gh` child process로 `pr view` JSON과 enable/disable argv를 확인한다.
- stale head, draft, conflict/unknown, changes requested, 0/failed/unavailable check는 merge command 전에 거부한다.
- enable은 `--auto --match-head-commit`, disable은 `--disable-auto --match-head-commit`을 반드시 포함하고 `--admin`은 없어야 한다.
- 실제 HTTP에서 비신뢰 접속 차단, 최소 감사 metadata와 기존 task event 연결을 검증한다.
- 350ms 응답에서 500ms 안에 disabled/진행 표시가 나타나며 mutation은 1회여야 한다.
- 15초 poll은 선택 PR만 다시 읽고 이전 요청과 겹치지 않으며 390px overflow가 없어야 한다.

참고: [GitHub CLI `gh pr merge`](https://cli.github.com/manual/gh_pr_merge), [GitHub auto-merge 안내](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/automatically-merging-a-pull-request)
