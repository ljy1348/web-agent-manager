---
name: web-agent-manager-session-context
description: web-agent-manager의 다른 Claude·Codex 채팅 번호나 프로젝트 작업 문맥을 조회한다. 사용자가 "채팅 160 참고", "세션 #160에서 이어서", "이 프로젝트의 Claude 작업 확인"처럼 말하면 사용한다.
---

# web-agent-manager 세션 문맥

1. MCP 도구가 보이면 `web_agent_manager_get_context`를 우선 사용한다.
2. 사용자가 채팅 번호를 말했으면 `chatId`에 그대로 넣는다. 번호를 추측하거나 현재 채팅으로 바꾸지 않는다.
3. 번호 없이 프로젝트만 말했으면 `web_agent_manager_list_projects`, `web_agent_manager_list_chats` 순서로 대상을 좁힌다.
4. 결과의 사용자·assistant·tool 메시지를 구분하고, 미완료 항목과 마지막 결정을 우선 확인한다.
5. MCP가 없으면 아래 CLI로 같은 구조화 API를 호출한다.

```bash
WEB_AGENT_MANAGER_ROOT="$(dirname "$(dirname "$(realpath .agents/skills/web-agent-manager-session-context 2>/dev/null || realpath .claude/skills/web-agent-manager-session-context)")")"
npm --silent --prefix "$WEB_AGENT_MANAGER_ROOT" run agent -- call context.get '{"chatId":160,"limit":80}'
```

세션 문맥 조회는 읽기 전용이다. 다른 채팅에 메시지를 보내야 할 때만 `web-agent-manager-delegate`를 사용한다.
