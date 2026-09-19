# 일반 프롬프트 원장 운영 가이드

작성일: 2026-09-12

일반 웹 프롬프트 원장은 `WEB_AGENT_MANAGER_TASK_LEDGER_V1`로 제어한다. 기본값은 활성화이며 `0`으로 설정하면 기존 `SessionManager.sendPrompt` 경로로 즉시 돌아간다. 플래그를 꺼도 이미 기록한 원장 행은 삭제하지 않는다.

## 상태 해석

- `received`: HTTP 접수가 DB에 커밋됨
- `dispatching`: TUI 전달 시도를 한 dispatcher가 선점함
- `delivered`: 제출 증거를 확인함
- `queued`: 이미 실행 중인 턴 뒤에 들어간 follow-up
- `started`: 공급자 JSONL에서 같은 user turn을 확인함
- `delivery_unknown`: 입력을 시도했지만 제출 여부를 증명하지 못함. 자동 재전송 금지
- `reconciled_delivered`, `reconciled_failed`: JSONL 또는 사용자 판단으로 조정됨

`delivery_unknown`은 실패가 아니다. 터미널 또는 공급자 기록을 확인한 뒤 `POST /api/prompt-commands/:id/reconcile`에 `resolution=delivered|failed`와 새 `Idempotency-Key`를 보낸다.

## 익명 지표 쿼리

프롬프트 원문은 저장하지 않으며 아래 쿼리는 상태·횟수만 집계한다.

```sql
SELECT state, COUNT(*) AS count
FROM prompt_commands
GROUP BY state
ORDER BY state;

SELECT
  COUNT(*) AS prompt_commands_received_total,
  COALESCE(SUM(replay_count), 0) AS prompt_duplicate_dispatch_prevented_total,
  COALESCE(SUM(CASE WHEN state = 'delivery_unknown' THEN 1 ELSE 0 END), 0) AS prompt_delivery_unknown_total,
  COALESCE(SUM(CASE WHEN state = 'rejected' THEN 1 ELSE 0 END), 0) AS prompt_rejected_total
FROM prompt_commands;

SELECT COUNT(*) AS task_busy_projection_mismatch_current
FROM chats c
WHERE c.busy != CASE WHEN EXISTS (
  SELECT 1 FROM agent_tasks t
  WHERE t.chat_id = c.id AND t.state IN ('running', 'verifying')
) THEN 1 ELSE 0 END;
```

관리자 API `GET /api/admin/task-ledger-metrics`도 같은 집계를 반환한다. projection 불일치를 충분히 관찰하기 전에는 기존 `chats.busy` 쓰기를 제거하지 않는다.

## 재시작 경계

서버 시작 시 `received` 또는 `dispatching`으로 남은 명령은 전부 `delivery_unknown`으로 옮긴다. 평문 outbox와 공급자 end-to-end 멱등 키가 없으므로 자동 재전송하지 않는다. 이후 JSONL에 접수 시각 이후의 같은 본문 해시가 나타나면 `reconciled_delivered`로 자동 조정한다.
