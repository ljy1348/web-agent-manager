# 목표 작업 보드·자원 라우팅

작성일: 2026-09-12

## 작업 보드의 정본

작업 탭은 브라우저 상태나 실행 중 tmux 목록을 별도 정본으로 만들지 않고 SQLite `agent_tasks`, `agent_task_events`, verification, rate-limit wait와 schedule을 한 번에 투영한다. 서버가 재시작돼도 같은 원장에서 다음 열로 복원된다.

- `Working`: created/running. `실행 중`, `idle`, `queue 대기`, `시작 대기`를 별도 badge로 표시한다.
- `Needs input`: 전달 불확실, 검증 승인 대기, 사용자의 판단이 필요한 task. rate limit이면 `한도 대기`와 재개 예정 시각을 따로 표시한다.
- `Verifying`: verification gate 실행 중
- `Failed`: failed/cancelled/budget_exceeded
- `Completed`: 필수 검증까지 통과한 완료 task
- `Scheduled`: 활성 일일·1회 schedule

task에는 목표, 완료 조건 최대 20개, 체크포인트 최대 50개, 다음 행동, 0~100 우선순위와 token/USD/실작업 분 예산을 저장할 수 있다. 모든 변경은 task event로 추가 기록된다. 성공한 verification은 run/commit/diff/time snapshot을 `last_verified_checkpoint`에 남기며 재개나 routing으로 기존 `profile_version_id`를 바꾸지 않는다.

## 추천과 명시 승인

`라우팅 추천`은 다음 입력을 snapshot으로 저장한다.

- 계정별 최신 remaining percent와 reset 시각. fresh가 아니면 숫자를 추측하지 않고 `확인 불가`다.
- 프로젝트·공급자·계정별 실행/예약 점유 수와 영속 동시 실행 상한
- 공급자별 최신 capability snapshot과 profile에 고정된 공급자·모델
- 비용 정보. 대화형 공급자가 실제 비용을 보고하지 않으면 `unavailable`로 표시하며 임의 가격을 만들지 않는다.

추천 생성만으로 채팅의 공급자·계정은 바뀌지 않는다. 관리자가 화면의 후보를 확인하고 별도 확인 대화상자에서 승인해야 `routing/apply`가 실행된다. 적용 트랜잭션은 추천 이후 다른 작업이 자리를 차지했을 가능성을 고려해 점유량을 다시 계산한다. profile/session/history가 고정된 채팅은 공급자를 바꾸지 못한다. 승인된 작업은 자리가 있으면 `admitted`, 없으면 우선순위 queue에 들어간다.

기본 동시 실행 상한은 프로젝트 3, 공급자 4, 계정 2다. 관리자 API로 범위별 1~100 값을 영속 설정할 수 있다. queue reconciler는 5초마다 종료 task의 예약을 풀고 높은 우선순위·오래 기다린 task 순으로 빈 자리를 승인한다. 이는 작업을 자동 전송하지 않고 “시작 가능” 상태만 결정하므로, 공급자 변경과 실제 실행 모두 사용자 통제를 유지한다.

```text
GET   /api/task-board
PATCH /api/tasks/:taskId/plan
POST  /api/tasks/:taskId/routing/recommend
POST  /api/tasks/:taskId/routing/apply
PUT   /api/task-board/limits/:scopeType/:scopeId
POST  /api/task-board/queue/reconcile
```

계획·추천 mutation은 관리자 전용이다. routing 적용, 동시 실행 상한 변경과 수동 queue 조정은 최근 재인증도 필요하다. `test_only` 계정은 보드를 조회할 수 있지만 계획·추천·적용·상한·queue를 변경할 수 없다.

## QA 기준

- DB 재개 뒤 목표·완료 조건·체크포인트·예산·profile·verified checkpoint가 동일하다.
- rate limit 대기와 idle이 서로 다른 badge와 reason으로 나온다.
- 추천 응답 전에 공급자/계정 불변이고, 같은 추천 요청은 멱등 재생된다.
- 추천 적용 시 점유량을 다시 계산하며 project/provider/account 상한과 priority 순서를 지킨다.
- 2,000 task fixture에서 최신 1,000개 보드 투영은 1초 미만이어야 한다.
- Chrome의 350ms 지연 추천에서 500ms 안에 disabled/진행 표시가 나타나고, 적용 전 요청이 0건이며 390px 페이지 전체 가로 overflow가 없어야 한다.
