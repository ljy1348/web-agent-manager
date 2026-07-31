---
name: web-agent-manager-delegate
description: 현재 작업을 web-agent-manager의 다른 Claude·Codex 자식 채팅에 맡기고 완료 결과를 회수한다. 명시적 위임 요청뿐 아니라 다른 공급자의 독립 구현·검토가 정확도를 실질적으로 높이는 복잡한 작업에도 사용한다.
---

# web-agent-manager 작업 전달

1. 전달 전에 `web_agent_manager_get_context`로 원본 채팅의 현재 상태를 읽는다. 현재 채팅 번호를 모르면 프로젝트 채팅 목록에서 같은 공급자의 최근 실행 채팅을 확인하되 확신할 수 없으면 `sourceChatId`를 생략한다.
2. 대상 채팅 번호가 있으면 `targetChatId`를 그대로 사용한다. 번호가 없으면 프로젝트와 반대쪽 `provider`를 명시하고 `createNew: true`로 독립 자식 채팅을 만든다.
3. 프롬프트에는 원본 채팅 번호, 완료된 내용, 남은 작업, 검증 기준, 결과 보고 형식을 포함한다.
4. 부모가 결과를 받아 현재 작업에 반영해야 하면 `web_agent_manager_delegate_and_wait`를 사용한다. 반환된 `result.response`를 그대로 신뢰하지 말고 현재 코드·검증 결과와 대조한 뒤 최종 결론에 병합한다.
5. 병렬로 맡기고 나중에 확인할 때만 `web_agent_manager_delegate` 후 `web_agent_manager_wait_delegation`을 사용한다.
6. 재시도할 수 있는 호출에는 동일한 `idempotencyKey`를 사용해 중복 전송을 막는다.
7. 전달받은 작업을 다시 넘기면 이전 `delegationId`를 `parentDelegationId`로 넣는다. 서버가 자기 호출·조상 재호출·4단계 초과를 차단한다.
8. 사용자가 명시하지 않은 자율 위임은 복잡한 구현·보안 검토·교차 검증처럼 이점이 분명할 때 한 번만 사용한다. 단순 질문이나 사소한 수정은 직접 처리한다.
9. MCP가 없으면 아래 CLI로 같은 구조화 API를 호출한다.

```bash
WEB_AGENT_MANAGER_ROOT="$(dirname "$(dirname "$(realpath .agents/skills/web-agent-manager-delegate 2>/dev/null || realpath .claude/skills/web-agent-manager-delegate)")")"
npm --silent --prefix "$WEB_AGENT_MANAGER_ROOT" run agent -- call delegation.send_wait '{"sourceChatId":160,"projectId":1,"provider":"claude","createNew":true,"prompt":"#160의 남은 작업을 이어서 완료하고 검증 결과를 보고하세요.","idempotencyKey":"160-to-claude-finalize","timeoutSeconds":300}'
```

사용자가 단순히 세션을 참고하라고 했으면 메시지를 보내지 않는다. 명시적 위임 요청 또는 8번의 제한된 자율 위임 조건에서만 전달한다.
