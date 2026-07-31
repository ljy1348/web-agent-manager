# TODO 목록

Codex CLI, Codex App, Claude Code CLI, Claude Code Desktop 기준으로 web-agent-manager에 없는 기능을 정리한다.
현재 web-agent-manager는 tmux 기반 Codex/Claude 세션을 웹에서 관리하는 운영 콘솔에 가깝고, 아래 항목은 공식 앱 수준의 작업대 경험으로 확장하기 위한 후보이다.

## 최우선

1. 프로젝트별 worktree 격리
   - 새 작업/채팅 시작 시 Git worktree와 작업 브랜치를 자동 생성한다.
   - 병렬 에이전트가 같은 프로젝트 파일을 동시에 수정해도 충돌하지 않게 한다.
   - 작업 완료 후 diff, 테스트, 커밋, PR, worktree 정리를 한 화면에서 처리한다.

2. 작업 보드 UI
   - 채팅 목록을 `Working`, `Needs input`, `Completed`, `Scheduled`, `Failed` 보드로 재구성한다.
   - 카드마다 공급자, 프로젝트, worktree/브랜치, 변경 파일 수, 승인 대기, 테스트 상태, 마지막 활동 시간을 표시한다.
   - Claude agent view와 Codex App의 병렬 작업 흐름을 웹에서 대체할 수 있게 한다.

3. Live preview 패널
   - 에이전트가 띄운 dev server 포트를 감지해 iframe preview로 보여준다.
   - 데스크톱/모바일 viewport 전환, console/network 로그, screenshot 캡처를 지원한다.
   - Playwright 검증 결과와 연결해 "눈으로 확인 가능한 작업 완료" 흐름을 만든다.
   - (Orca Design Mode 참고) preview에서 UI 요소를 클릭하면 해당 요소의 HTML·computed CSS·크롭 스크린샷을 묶어 에이전트 입력으로 전달한다.

4. Visual diff review
   - 파일별 diff뿐 아니라 hunk별 accept/reject를 지원한다.
   - 파일 단위 되돌리기, hunk 단위 적용, review 완료 후 커밋을 지원한다.
   - 이미지/바이너리 변경은 미리보기 또는 파일 메타데이터 중심으로 보여준다.
   - (Orca Annotate AI Diff 참고) diff 라인에 리뷰 주석을 달고, 주석 전체를 라인 앵커와 함께 하나의 프롬프트로 묶어 에이전트에 재전송한다. 주석은 수정 후에도 유지해 해결 여부를 확인한다.

## Codex CLI parity

1. 실행 옵션 UI
   - `--sandbox`, `--ask-for-approval`, `--model`, `--profile`, `--add-dir`, `--search`, `--oss`, `--local-provider`를 채팅 시작 옵션으로 노출한다.
   - 프로젝트별 기본값과 채팅별 override를 분리한다.

2. 비대화형 실행
   - `codex exec`를 웹에서 실행하고 stdout/stderr, exit code, 생성 diff를 저장한다.
   - 반복 가능한 작업 템플릿과 CI용 실행 이력을 제공한다.

3. 코드 리뷰 실행
   - `codex review` 결과를 GitHub PR/로컬 diff와 연결한다.
   - finding별 상태, 해결 여부, follow-up 작업 생성을 지원한다.

4. 세션 관리
   - `codex resume`, `fork`, `archive`, `unarchive`, `delete`, `apply`를 웹 메뉴로 제공한다.
   - 공급자 고유 세션 ID와 web-agent-manager 채팅 ID의 매핑을 명확히 보여준다.

5. MCP 관리
   - `codex mcp` 서버 목록, 추가/삭제, 인증 상태, 노출 도구 목록을 관리한다.
   - 세션별 MCP 활성화/비활성화를 지원한다.

6. 플러그인 관리
   - `codex plugin` 설치/삭제/업데이트/활성화 상태를 보여준다.
   - 플러그인별 스킬, MCP, 설정 파일을 한 화면에서 관리한다.

7. Codex Cloud
   - `codex cloud` 작업 목록, 새 작업 생성, 결과 diff 확인, 로컬 적용을 지원한다.
   - cloud task와 로컬 web-agent-manager 작업을 같은 보드에 표시한다.

8. app-server 기반 어댑터
   - tmux/TUI 파싱 대신 Codex app-server의 stream event, approval, history 표면을 사용하는 선택 어댑터를 만든다.
   - 기존 TUI 어댑터와 병행 운영한다.

## Codex App/Desktop parity

1. 원격 호스트 연결
   - SSH host 등록, 연결 테스트, remote project folder 선택을 지원한다.
   - 원격 호스트에서 web-agent-manager worker 또는 Codex app-server를 시작하고 상태를 감시한다.

2. 모바일 dispatch UX
   - 모바일 웹을 승인/새 작업/짧은 follow-up 중심으로 재설계한다.
   - 작업 완료, 승인 요청, 실패, 리밋 초기화 push 알림을 강화한다.

3. Automations
   - 반복 작업과 조건부 작업을 등록한다.
   - 예: 매일 테스트 실패 확인, 특정 브랜치 변경 감시, PR 생성 시 자동 리뷰.

4. Goal 기반 장기 작업
   - 목표, 완료 조건, 예산, 중단/재개 정책을 저장한다.
   - 에이전트가 목표 달성 전까지 여러 턴을 이어갈 수 있게 한다.

5. Sites/브라우저 작업 통합
   - 웹앱 preview, browser automation, screenshot 비교, console/network 로그를 작업 결과에 포함한다.
   - Codex App의 Sites/Chrome attachment 흐름에 대응한다.

## Claude Code CLI parity

1. 실행 옵션 UI
   - `--allowedTools`, `--disallowedTools`, `--add-dir`, `--agent`, `--agents`, `--model`, `--effort`, `--bare`, `--debug`, `--debug-file`, `--chrome`, `--ide`, `--max-budget-usd`를 채팅 시작 옵션으로 노출한다.
   - 옵션을 프로젝트 기본값, 사용자 기본값, 채팅 override로 나눈다.

2. 비대화형/SDK 실행
   - `claude -p` 실행을 웹에서 지원한다.
   - `--output-format json`, `stream-json`, `--json-schema`, `--input-format stream-json` 결과를 저장하고 재생한다.

3. Background agents
   - `claude --bg`와 `claude agents`의 세션 목록을 조회한다.
   - Needs input, Working, Completed 상태를 web-agent-manager 작업 보드와 통합한다.

4. Subagents
   - `.claude/agents` 또는 `--agents` 기반 custom subagent를 관리한다.
   - 작업 시작 시 사용할 agent를 선택하고, subagent별 진행/결과를 별도 카드로 표시한다.
   - 완료(2026-07-31): 교차 공급자 호출은 web-agent-manager 스킬과 자체 MCP/Unix socket 브리지를 통해 새 Claude·Codex tmux 채팅에 주입하고, JSONL 완료 응답을 회수해 부모에 반환한다.
   - CLI끼리 직접 연결(`codex mcp-server`↔`claude mcp serve` 상호 등록)이나 비대화형 `-p` 실행은 쓰지 않는다 — 모든 교차 호출이 web-agent-manager를 경유해야 세션 관리·승인·이력이 한곳에 남는다.
   - 완료(2026-07-31): 관리자 서브 에이전트 패널에서 부모·대상 채팅 관계와 상태를 조회하고 새 자식 생성·중단·종료·재시작·열기를 관리한다.
   - 웹 UI에 교차 호출 허용 공급자·최대 횟수 같은 세부 정책 설정을 추가한다.
   - 완료(2026-07-31): 설치·서버 시작·Electron 시작 시 스킬 연결 상태를 보정하고, 화면에서 누락된 공급자의 스킬+MCP 원클릭 연결과 60초 재감지를 제공한다.

5. Hooks 관리
   - PermissionRequest 외에도 PreToolUse, PostToolUse, Notification, Stop 등 hook을 프로젝트별로 관리한다.
   - hook 실행 로그, 실패 이력, 임시 비활성화, 테스트 실행을 지원한다.

6. MCP/Connector 관리
   - Claude MCP 서버 목록, OAuth login/logout, tools list, 세션별 enable/disable을 지원한다.
   - `.mcp.json` 편집과 검증을 제공한다.

7. Skills/custom commands
   - `.claude/skills`, `.claude/commands`를 목록화하고 편집한다.
   - bundled skills 호출과 사용자 skill scaffold를 지원한다.

8. Session 기능
   - `--continue`, `--resume`, `--fork-session`, `--from-pr`, `--name`, `--no-session-persistence`를 웹 UI에 노출한다.
   - PR-linked session을 GitHub 탭과 연결한다.

9. Memory/지침 통합
   - 프로젝트 `AGENTS.md`를 canonical 지침으로 두고 `CLAUDE.md`가 `@AGENTS.md`로 import하도록 관리한다.
   - Claude 전용 내용은 `CLAUDE.md` 하단 섹션에 분리한다.
   - 전역 지침도 `~/.claude/CLAUDE.md`가 `~/.codex/AGENTS.md`를 import할 수 있게 한다.

## Claude Code Desktop parity

1. Git isolation parallel sessions
   - Claude Desktop처럼 병렬 세션이 서로 격리된 Git worktree에서 실행되도록 한다.
   - 세션별 브랜치, 작업 디렉터리, 원본 프로젝트 연결을 보여준다.

2. 드래그 앤 드롭 레이아웃
   - 채팅, 터미널, 파일 편집기, diff, preview pane을 사용자가 재배치할 수 있게 한다.
   - 레이아웃 preset과 사용자별 저장을 지원한다.

3. 통합 파일 에디터
   - Monaco 기반 일반 코드 편집, 저장, dirty state, syntax highlighting, search를 지원한다.
   - 에이전트가 수정한 파일을 diff에서 바로 열 수 있게 한다.

4. App preview
   - live preview와 빌드/test 결과를 세션 카드에 연결한다.
   - 에이전트가 preview를 열거나 스크린샷을 찍은 결과를 대화에 첨부한다.

5. PR monitoring with auto-merge
   - PR checks, review, conflict, branch 상태를 주기 조회한다.
   - 조건 충족 시 자동 merge하거나 실패 시 follow-up agent를 생성한다.

6. Scheduled tasks
   - Claude Desktop scheduled task 흐름처럼 자연어 기반 예약 작업 생성 UI를 제공한다.
   - 실행 이력, 다음 실행 시각, 마지막 실패 원인을 표시한다.

7. Side chats
   - 현재 작업을 방해하지 않는 보조 질문/분석 채팅을 제공한다.
   - 선택한 diff, 파일, 로그, terminal output을 side chat context로 전달한다.

8. Computer use / Chrome
   - browser control, screenshot, DOM/console/network inspection을 에이전트 도구로 연결한다.
   - 사용자가 위험 동작을 승인할 수 있는 별도 approval UI를 제공한다.

9. Connectors / enterprise config
   - Slack/ntfy 외에 GitHub, Sentry, Linear, Jira, Figma, Google Drive 같은 connector 상태를 관리한다.
   - 조직 정책, 허용 도구, 감사 로그 export를 제공한다.

## 서드파티 참고 (Orca)

worktree 격리, diff 리뷰, Monaco 에디터, SSH 원격, automations 등 Orca와 겹치는 항목은 위 섹션에 이미 있으므로 여기서는 그 외 후보만 둔다. web-agent-manager 고유 축(rate limit 자동 재개, 웹 승인, 공개 노출 보안, Slack/ntfy, JSONL 채팅 UI)은 Orca에 없음을 확인했으므로 유지한다.

1. 공급자 멀티 계정 핫스왑
   - Claude/Codex 계정을 여러 개 등록하고 재로그인 없이 활성 계정을 전환한다.
   - 계정별 사용량·리밋을 따로 표시하고, 실행 중 세션은 기존 계정을 유지한다.

2. 유휴 세션 하이버네이션
   - 완료 후 일정 시간 입력이 없는 tmux 세션을 자동 종료해 리소스를 회수한다.
   - 기존 "저장된 세션 ID로 자동 resume" 흐름을 재사용해, 다시 열면 이어서 진행되게 한다(파괴적 단축이 되지 않도록 종료 조건을 명확한 idle 신호로만 판정).

## 공통 품질 과제

0. MCP 등록 UX 간소화 (개선안 확정, 2026-07-19)
   - 현재: `ToolsView.tsx`의 MCP 폼이 이름·Command·Args·URL·CWD·Env JSON·Headers JSON을 전부 수동 입력받는다. 생태계 표준(README의 `"mcpServers"` JSON 조각 배포, `claude mcp add`/`codex mcp add` 원라인, 마켓플레이스 원클릭) 대비 뒤떨어짐.
   - 개선 1 — 붙여넣기 단일 입력을 기본 화면으로: 입력 하나에 (a) `mcpServers` JSON 조각 또는 서버 객체 JSON, (b) `claude mcp add ...`/`codex mcp add ...`/`npx ...` 명령줄, (c) 순수 URL 중 무엇을 붙여넣어도 형식을 자동 감지·파싱해 이름/transport/필드를 채운다. 기존 개별 필드는 "고급"으로 접어 확인·수정 용도로만 둔다.
   - 개선 2 — marketplace 탭 원클릭 등록: 카탈로그의 MCP 항목에 [추가] 버튼을 달아 미리 채워진 확인 화면 한 번으로 등록한다.
   - 개선 3 — web-agent-manager 자체 MCP·스킬은 버튼 하나로 등록/해제(위 Subagents 항목의 자동 설치와 동일 흐름).

1. 공식 이벤트 API 우선 사용
   - 가능한 경우 TUI 화면 파싱보다 app-server, Agent SDK, stream-json 같은 구조화 이벤트를 우선 사용한다.

2. 보안 프로파일
   - sandbox, permission mode, allowed/disallowed tools, MCP, hooks를 하나의 정책으로 묶는다.
   - 프로젝트별 기본 정책과 채팅별 override를 제공한다.

3. 감사/관측성
   - 작업 단위 timeline, tool call, approval, diff, test result, notification delivery를 연결한다.
   - 운영자가 검색 가능한 감사 로그 UI를 제공한다.

4. 배포/공유 준비
   - 완료(2026-07-31): Linux·macOS·Windows WSL2 단일 실행 설치 스크립트, 버전별 ZIP, Electron 설치 파일과 운영체제별 CI 빌드를 추가했다.
   - systemd setup helper, demo screenshots, sample config, 보안 가이드를 정리한다.
   - 외부 공개용 README와 운영자용 문서를 분리한다.

## 참고

- Codex CLI reference: https://developers.openai.com/codex/cli/reference
- Codex App features: https://developers.openai.com/codex/app/features
- Codex remote connections: https://developers.openai.com/codex/remote-connections
- Codex mobile workflow: https://openai.com/index/work-with-codex-from-anywhere/
- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
- Claude Code Desktop: https://code.claude.com/docs/en/desktop
- Claude Desktop quickstart: https://code.claude.com/docs/en/desktop-quickstart
- Claude agent view: https://code.claude.com/docs/en/agent-view
- Claude memory imports: https://code.claude.com/docs/en/memory
- Orca (worktree 기반 에이전트 IDE, 비교 참고): https://www.onorca.dev/docs
