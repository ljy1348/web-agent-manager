# 자격증명 vault 운영 절차

WAM이 설정 화면이나 MCP 등록 API로 직접 받은 Slack bot token과 MCP `env`/`headers` 값은 SQLite 일반 설정 열이나 CLI 설정 파일에 평문으로 저장하지 않는다. `credential_vault_entries`에는 AES-256-GCM 암호문·nonce·인증 tag와 소유 범위·용도·회전 version만 저장한다. master key는 데이터 디렉터리의 `secrets/credential-vault.key`에 32바이트, 디렉터리 `0700`·파일 `0600`으로 둔다.

공급자 CLI가 자체 로그인으로 만든 `~/.claude`, `~/.codex`, `~/.grok` 및 WAM 계정 슬롯의 인증 파일은 vault 대상이 아니다. WAM은 그 내용을 읽거나 복사하지 않고 공식 설정 디렉터리 환경변수만 선택한다.

## MCP 전달 방식

- Claude 프로젝트 `.mcp.json`: `env`와 `headers` 값에는 `${WAM_VAULT_...}` 참조만 기록한다. Claude Code의 [공식 MCP 환경변수 확장 문서](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson)가 설명하는 표면이다.
- Grok `config.toml`: `env`와 `headers` 값에는 같은 형식의 `${WAM_VAULT_...}` 참조만 기록한다. Grok의 [공식 MCP 서버 문서](https://docs.x.ai/build/features/mcp-servers)가 이 확장을 지원한다.
- Codex `config.toml`: stdio 값은 `env_vars` allowlist로 원래 변수명을 전달하고 HTTP header는 `env_http_headers`에서 header 이름을 vault 환경변수에 매핑한다. [OpenAI Docs의 Codex 설정 참조](https://learn.chatgpt.com/docs/config-file/config-reference)가 정의한 방식이다. 한 프로젝트에서 서로 다른 MCP 서버가 동일한 stdio 환경변수명에 서로 다른 값을 요구하면 프로세스 환경에서 구분할 수 없으므로 저장 시 거부한다.

설정 파일에는 환경변수 이름만 남는다. 채팅 시작 직전에 해당 프로젝트·공급자 바인딩만 30초 내부 lease로 복호화해 자식 프로세스 환경에 전달한다. WAM의 메모리 참조와 Buffer는 프로세스 생성 직후 지우지만, 시작된 CLI와 그 MCP 자식은 세션이 끝날 때까지 환경값을 보유한다. 실행 중인 세션의 자격증명을 회전했다면 그 세션을 안전하게 종료·재시작해야 새 값을 사용한다. MCP 목록/상태 명령은 확장된 값을 출력하는 공급자가 있으므로 카탈로그 조회에는 vault 값을 주입하지 않는다.

## migration과 장애 대응

서버 시작 시 예전 `slack_settings.bot_token` 평문이 있으면 같은 transaction에서 vault로 암호화하고 원문 열을 `NULL`로 비운다. 기존 MCP 설정의 평문은 의미를 추측해 자동 변환하지 않는다. 관리자가 해당 env/header를 다시 저장할 때부터 vault 참조로 교체한다.

암호문이 있는데 master key가 없거나 권한·길이가 잘못됐거나 다른 key라면 서버는 fail-fast한다. key만 새로 만들면 기존 암호문은 복구되지 않는다. 전체 백업에는 DB와 이 key를 함께, 소유자 전용 권한과 별도 백업 암호화 아래 보존해야 한다.

원문을 반환하는 HTTP API는 없다. 감사 로그에는 공급자·프로젝트·transport와 env/header 존재 여부만 남긴다. `test_only` 계정은 전역 mutation allowlist에 MCP/vault 경로가 없으므로 저장·수정·삭제와 lease 실행이 403이다.

## QA 기준

`tests/credential-vault.test.ts`는 암호문 비저장, key 권한·유실·AAD 변조 실패, Slack 평문 migration과 실제 fetch 주입, 세 공급자 참조 형식, 프로젝트/공급자 범위, Codex 충돌 거부, API·감사 로그 비노출을 실제 임시 SQLite와 설정 파일로 검증한다. 100개 비밀의 launch 환경 준비는 CI에서 1초 상한을 적용한다. `tests/credential-vault-cli.test.ts`는 설치된 실제 세 CLI가 있으면 격리 HOME/config에서 참조 문법을 parse하는 smoke를 수행한다. 외부 Slack·유료 모델 호출과 운영 CLI 설정은 사용하지 않는다.
