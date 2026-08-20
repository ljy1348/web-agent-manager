# web-agent-manager

Linux·macOS와 Windows WSL2에서 Codex CLI와 Claude Code의 실제 인터랙티브 TUI를 한 웹 화면으로 관리하는 애플리케이션이다. 각 채팅은 독립 tmux 세션과 PTY를 사용하며, 대화 내용은 터미널 문자열이나 DB 미러링이 아니라 공급자 전역 JSONL 기록을 매 요청 직접 읽어(mtime 캐시 적용) 커서 페이지네이션으로 표시한다. DB에는 앱 자체 메타데이터(상태·프로젝트·tmux·approval)와 삭제 후에도 유지할 숫자형 토큰 사용 이벤트만 저장하며 메시지 본문은 복제하지 않는다.

보안 문제는 [SECURITY.md](SECURITY.md)의 비공개 절차로 제보한다. 개발 참여 방법은 [CONTRIBUTING.md](CONTRIBUTING.md), 릴리즈별 변경 내용은 [CHANGELOG.md](CHANGELOG.md)에서 확인한다. 이 프로젝트는 [MIT License](LICENSE)로 배포한다.

## 주요 기능

- 데스크톱과 모바일에서 같은 네이비·바이올렛 디자인 체계, 아이콘 탭 내비게이션, 명확한 활성/포커스 상태와 44px 안팎의 모바일 조작 영역을 사용한다. 모바일의 비채팅 화면에도 현재 프로젝트 선택을 유지하고, 채팅은 목록·대화·터미널·입력 영역을 한 화면 높이 안에서 독립적으로 관리한다
- 채팅 목록은 데스크톱 사이드바와 모바일 메뉴 모두 `프로젝트 채팅`과 `<브랜치> 워크트리`로 묶여 개수와 함께 접었다 펼 수 있고, 묶음마다 Claude·Codex·Grok 채팅을 바로 시작한다(워크트리 묶음에서 시작하면 같은 폴더를 쓰는 채팅이 된다). 묶음은 채팅이 아니라 저장소의 실제 worktree 목록을 기준으로 만들기 때문에, 아직 채팅이 하나도 없거나 앱 밖에서 만든 worktree도 `0` 개수와 `채팅 없는 작업공간입니다.` 안내와 함께 그대로 보인다 — 워크트리가 지워진 것인지 채팅만 없는 것인지 화면에서 구분되며, 그 묶음에서 바로 채팅을 시작하면 새 폴더를 만들지 않고 이미 있는 worktree 폴더에 연결한다(목록은 30초마다 다시 읽어 밖에서 만든 worktree도 곧 나타난다). 워크트리 채팅을 백업 후 삭제하는 동작은 그대로이며, 그 워크트리를 쓰던 마지막 채팅이 사라지면 폴더도 함께 정리하고 알림으로 알려준다
- Codex·Claude·Grok 새 채팅, 채팅 ID 주소(`?chat=번호`)로 바로 열기, 계정별 마지막 프로젝트·채팅과 화면 모드 복원, 일반 질문과 슬래시 명령 입력. 채팅 상단에서 기본 `채팅 모드`와 현재 CLI의 PTY가 남은 작업영역 전체를 쓰는 `터미널 모드`를 즉시 전환하며 선택은 웹 사용자 계정에 저장된다
- 탭·프로젝트·채팅·파일 폴더·미리보기 위치와 열린 관리 팝업을 브라우저 history에 기록해 뒤로가기/앞으로가기로 web-agent-manager 내부 탐색 및 팝업 닫기
- Codex 내부 권한 상승 검토용 JSONL과 실제 사용자 메시지가 없는 Claude 상태 조회·local-command 전용 JSONL 세션은 일반 채팅 목록에 노출하지 않음
- 응답은 마크다운(GFM: 표·코드블록·목록 등)으로 렌더링, 도구 실행·diff 상세는 체크박스를 켜야만 노출(기본은 완전히 숨김, 켜면 실제로 펼쳐짐)하고 diff는 GitHub·git처럼 줄 색상으로 표시. 대화 가상 스크롤은 하단을 보고 있을 때 새 답변을 계속 따라가되 wheel·touch·pointer 입력이 시작되면 자동 추적을 즉시 멈추고 과거 위치를 보존하며, 실제 사용자 스크롤에서만 이전 메시지를 추가로 불러옴
- 터미널 모드에서 텍스트를 선택한 채 Ctrl+C를 누르면 SIGINT 대신 선택 영역을 클립보드로 복사(선택이 없으면 평소대로 인터럽트). 모드 전환 직후 xterm에 포커스가 들어가 현재 tmux 세션에 바로 키 입력 가능. PC에서는 글자 크기·줄 간격과 256열을 유지한 채 패널 높이로 실제 행 수를 계산하고, 브라우저 xterm·PTY·tmux·서버 화면에 같은 행 수를 적용해 남은 세로 공간을 쓴다. 터미널 위에서 마우스 휠을 굴리면 페이지가 아니라 실제 CLI처럼 tmux 기록(copy-mode)이 위아래로 움직인다(화면 우상단에 `[46/365]` 같은 tmux 위치 표시가 함께 뜬다). 기록의 정본은 tmux 하나뿐이며(브라우저 xterm은 스크롤백을 쌓지 않는다), 기록을 올려둔 상태에서 터미널에 키를 입력하거나 웹에서 질문·승인·중지를 보내면 자동으로 실시간 화면으로 돌아온다. TUI가 mouse mode를 켜고 있으면 휠은 지금까지처럼 그 TUI의 입력으로 그대로 전달된다. 모바일은 상하 스와이프로 먼저 256×36 고정 화면의 잘린 행을 이동하고 끝에 닿으면 tmux 기록을 옮기며, TUI가 mouse mode를 켰으면 실제 PTY wheel 입력으로 바꾼다. 좌우 스와이프는 고정 화면 안에서만 이동해 바깥 페이지가 움직이지 않는다. 하단 키 바의 `⌨ 키보드`, 일회성 `Ctrl`·`Alt`, `Esc`·`Tab`·`Shift+Tab`·방향키·`PgUp`·`PgDn`·`Enter`·`Ctrl+C/D`로 소프트 키보드에 없는 조합도 직접 입력한다
- Alt+Enter 또는 Ctrl+Enter로 메시지 전송, 전송 즉시 사용자 메시지를 화면에 먼저 표시하고 JSONL 반영이 확인되면 실제 메시지로 교체. tmux의 bracketed paste와 공급자별 붙여넣기 안정화 지연을 사용하며, 유휴 Codex·Claude·Grok은 실제 작업중 또는 빈 입력창 전환을 확인해 Enter를 한 번만 재시도하고 끝까지 제출되지 않으면 거짓 `작업중`과 남은 초안을 원복한다. 새 TUI는 입력 프롬프트가 준비된 뒤에만 첫 메시지를 보내며, 작업 중인 Codex·Claude·Grok에는 후속 질문·명령을 TUI 큐로 보내고 중지 버튼도 함께 제공
- 채팅창에서 이미지 붙여넣기·파일 드래그앤드롭·첨부 버튼으로 업로드, 프로젝트 폴더 저장 경로를 실제 터미널 입력에 반영하며 전용 worktree 채팅에는 같은 상대경로로 복제. 1,000자를 넘는 일반 텍스트 붙여넣기는 자동으로 UTF-8 `.txt` 첨부로 바꾸고, API에 긴 본문을 직접 전송해도 서버가 같은 방식으로 파일화해 TUI에는 짧은 파일 읽기 지시만 전달한다(슬래시·셸 명령은 원문 유지). 이미지는 전송 전 입력창 위 썸네일 미리보기와 메시지 목록에서의 인라인 미리보기 모두 지원. AI 응답의 현재 프로젝트 절대·상대 파일 링크와 `[첨부: 경로]` 표기는 현재 채팅 작업공간 기준으로 정규화해, 이미지는 메시지 안에 표시하고 일반 파일은 페이지를 벗어나지 않은 채 파일 탭의 해당 경로·미리보기로 이동한다. 업로드 첨부는 파일당 25MB·총 50MB·5개 제한을 클라이언트와 서버가 공유해 초과 파일은 전송 전에 바로 안내하고, 진행률을 퍼센트로 표시한다. 업로드 첨부는 프로젝트·채팅 소유권을 확인하는 전용 API로 미리보기·다운로드
- 입력창에 `@`(현재 프로젝트 파일, 이름 부분일치 검색)·`#`(전체 프로젝트 채팅, 제목·번호·공급자 검색)를 입력하면 슬래시 명령과 같은 자동완성 드롭다운이 뜨고, 선택하면 클릭 가능한 링크가 삽입된다. 파일 링크는 페이지를 벗어나지 않고 파일 탭으로 이동하며, 채팅 링크는 프로젝트가 달라도 그 채팅으로 바로 이동한다. 파일 탭 텍스트 미리보기는 줄 번호와 함께 표시되고, 줄마다 호버하면 나오는 링크 버튼으로 그 줄을 기존 채팅에 연결하거나 그 참조로 새 채팅을 바로 만들 수 있다(연결된 채팅 입력창에 `[경로:줄](경로#L줄)`이 채워지며, 이후 그 링크를 다시 누르면 파일 탭에서 해당 줄로 스크롤·강조된다)
- 채팅창에 시작 배너·하단 상태줄·JSONL 기록(턴마다 갱신되어 배너 파싱을 놓쳐도 복구됨)으로 감지한 현재 모델과 공급자 대표 사용량(Codex 주간, Claude 현재 세션)·초기화 시각 표시. assistant 응답의 JSONL usage가 있으면 말풍선 아래에 응답별 총 토큰과 입력·캐시·출력·추론 세부량을 작은 보조 문구로 표시하며, 페이지네이션된 일부 메시지로 부정확한 채팅 전체 누계는 만들지 않는다. Codex·Claude `/model` 화면을 파싱한 모델 선택과 추론 강도 적용 지원(Claude 최신 TUI는 `/effort <강도>` 별도 명령으로 적용, 모델 옵션은 채팅별 마지막 성공값을 유지하되 적용할 때는 실제 채팅의 최신 메뉴에서 같은 모델 ID의 현재 번호를 다시 찾아 선택)
- Grok(`grok` CLI)은 채팅 코어 범위에서 Codex·Claude와 같은 방식으로 동작한다. 새 채팅·resume, 기록 자동 발견과 대화 동기화, 작업중·완료 표시, 도구 실행 승인, 모델·추론 강도 변경, 권한 모드 표시, 계정 슬롯(`GROK_HOME`)까지 지원한다. Grok은 세션을 파일 하나가 아니라 디렉터리(`~/.grok/sessions/<URL인코딩 cwd>/<세션UUID>/`)로 저장하고 대화 본문은 `chat_history.jsonl`, 턴 종료는 `events.jsonl`의 `turn_ended`에만 남기므로 두 파일을 함께 읽어 완료를 판정한다(도구 호출 직전 설명 문장을 완료로 오인하지 않기 위함). 승인 화면은 선택지 구성이 도구마다 달라 고정 번호를 쓰지 않고 화면에 실제로 뜬 선택지 문구에서 번호를 찾아 누른다. 사용량은 `/usage show` 화면에서 플랜 주간 한도(예: `Weekly limit (SuperGrok)`)의 사용률과 초기화 시각을 읽고, 같은 화면의 세션 토큰·호출·비용 줄을 참고 활동으로 함께 남긴다(`/usage`만 보내면 show·manage 하위 선택에서 멈추고, 이 화면은 입력창을 덮는 모달이라 파싱 뒤 Esc로 닫아야 다음 주기 조회가 입력창에 들어간다). 응답별 말풍선 토큰은 `updates.jsonl`의 `turn_completed.usage`를 그 턴의 마지막 assistant에 붙여 Claude·Codex와 같은 원장 경로로 저장한다. `chat_history.jsonl`에는 usage가 없고, Grok 숫자는 Codex처럼 입력에 캐시 읽기가 포함되며 합계는 다시 더하지 않는다. 에이전트 실험실(Agent Lab)과 자식 채팅 위임, 전역 스킬·MCP 자동 연동은 아직 Codex·Claude 전용이다
- 응답별 숫자형 토큰 사용 이벤트는 공급자·세션·메시지 ID를 안정 키로 SQLite 원장에 멱등 저장하고, 대시보드에서 최근 7·30·90일·1년 또는 전체 기간을 프로젝트·채팅·일자·공급자·계정·모델별로 집계한다. 채팅 삭제 직전에 최신 JSONL을 다시 보존하고 삭제 표시만 남기므로 백업 사본까지 나중에 지워도 통계는 유지되며, 기능 도입 전 백업은 서버 시작 때 역수집한다. 단, 원장 도입 전에 백업 없이 이미 삭제되어 JSONL 근거가 전혀 없는 채팅은 복구할 수 없다
- 채팅 제목 옆 편집 버튼으로 이름을 바꾸면 Codex·Claude 공통 `/rename` 명령을 실제 CLI 세션에 그대로 보내고(터미널에서 `codex resume`·`claude --resume`으로 찾을 때도 그 이름이 쓰임) web-agent-manager 쪽 제목도 즉시 갱신, 사람이 직접 바꾸지 않은 채팅은 Claude가 CLI에서 이미 보여주는 표시 이름(자동 생성 기본값 또는 실제 터미널에서 `/rename`으로 바꾼 값)이나 대화 요약 제목(aiTitle)이 있으면 첫 메시지 그대로 대신 그 이름으로 계속 자동 갱신(직접 바꾼 제목은 절대 덮어쓰지 않음)
- 모바일과 세로가 짧은 노트북(높이 900px 이하)에서는 모델·상태·사용량 컨트롤이 담긴 상태바를 한 줄 요약으로 접어두고, 눌러야 기존 전체 컨트롤(모델·추론 강도 선택, 모드 전환 등)이 펼쳐짐(넓고 높은 화면은 항상 펼쳐진 상태 유지). 접힌 요약에도 `사용량 12% · 초기화 1:40pm (Asia/Seoul)`처럼 사용량과 초기화 시각을 함께 남겨 펼치지 않고 확인 가능(390px 모바일은 한 줄을 넘기지 않게 퍼센트만)
- 노트북 화면에서는 헤더·프로젝트 바·채팅 머리말·모드 탭·입력창 여백과 상태바를 함께 압축해, 위아래로 쌓이는 고정 영역을 약 107px 줄이고 그만큼을 대화 영역에 넘긴다(1440×900 기준 대화 영역이 1440×1000일 때보다 오히려 넓다)
- Claude 채팅 실행 중에는 "모드 전환" 버튼으로 Shift+Tab을 tmux에 전달해 기본(권한 요청)·auto-accept edits·plan mode를 순환
- 터미널 실행 상태, 전송 중 상태, pending 승인, 리밋 재개 대기를 합쳐 채팅별 `대기중`·`작업중`·`권한 요청`·`리밋 대기` 상태 표시(Codex 작업중 상태줄은 프롬프트 위/아래 위치 모두 감지, Claude는 도구 호출 턴과 순간적인 idle 화면 깜빡임을 완료로 오판하지 않으며, 종료된 채팅은 불완전한 외부 기록에 busy가 남아도 `종료`를 우선 표시), 채팅 목록은 ID를 함께 표시하고 최근 작업순으로 재동기화
- 작업중일 때는 전송 버튼이 중지 버튼으로 바뀌어, 클릭하면 ESC로 진행 중인 응답을 중단하고 잠시 후 터미널이 실제로 입력 가능한 상태인지 다시 확인, 입력창이 비어 있으면 방금 중단시킨 질문을 그대로 복구(이미 입력해둔 내용이 있으면 덮어쓰지 않음)
- 종료된 채팅은 웹에서 "터미널 시작" 버튼으로 다시 시작하거나, 입력 시 저장된 공급자 세션 ID로 자동 resume
- 채팅 세션을 앱 데이터 디렉터리에 백업하고, 공급자 JSONL과 앱 메타데이터를 바로 삭제하거나 백업 후 삭제하며, 백업 JSONL을 원래 공급자 기록 저장소로 복원하거나 필요 없어진 백업 사본만 목록에서 바로 삭제(원본 채팅은 그대로 유지)
- 서버 재시작 후 앱 소유 tmux 재연결 및 기존 전역 세션 자동 등록
- 채팅 목록과 채팅 제목 메타·GitHub 화면의 작은 메뉴에서 현재 Git 브랜치·실제 작업경로 표시, 기존·새 브랜치 전환과 프로젝트 공유 checkout/채팅 전용 worktree 선택. 여러 채팅은 전용 worktree로 서로 다른 브랜치를 동시에 사용하며, AI가 별도로 만든 `git worktree`도 전체 목록에서 발견해 tmux 현재 경로가 일치하면 자동 연결하고 그 외에는 관리자가 대상 채팅을 명시해 연결. 실행 중 터미널이나 미커밋 변경이 있는 작업공간은 전환·제거를 차단
- Codex TUI 승인 호환 계층, Claude `PermissionRequest` 훅 기반 웹 승인과 훅 밖 rate-limit 선택·대형 세션 resume 선택·디렉터리 신뢰 확인(y/n)·경량 모델 전환 화면 감지(요청유형에 맞는 버튼 라벨과 알림 요약 표시), 선택 채팅 안에서 인라인 승인 처리. Claude 최종 응답이 기록되면 유실된 훅 대기를 자동 정리하고 완료 채팅의 잔여 요청은 안전하게 닫을 수 있음. 데스크톱 권한 요청 패널은 현재 프로젝트에 대기 요청이 있을 때만 나타나고 평소에는 채팅 본문이 해당 폭을 사용
- 공급자별 전용 상태 PTY, 60초 주기 사용량 및 reset 시각 조회(Claude 상태 PTY는 인증·내장 명령만 남기는 safe mode와 screen-reader 출력으로 실행). 실제 대화가 없어 Claude 5시간 세션 창이 조회에서 사라지거나 0%가 되고, Codex 창이 직전 양수에서 0%로 바뀌면 `[WAM usage] 1이라고만 답해.` 최소 턴을 새 초기화 창마다 한 번 보내 롤링 초기화 시각을 실제 활동에 고정한다. 반복 `/usage`가 쌓인 장수 조회 세션을 모델 턴에 재사용하면 JSONL 실측상 다음 최소 턴의 캐시 생성 입력이 약 2만 토큰씩 증가하므로, 최소 턴은 매번 깨끗한 임시 상태 PTY에서 실행하고 응답 직후 폐기한다. 초기화 절대시각 기반 창 키를 DB에 저장해 같은 창의 반복 조회·서버 재시작 중복은 막되 새 창이면 직전 전송 후 5시간이 지나지 않아도 즉시 보낸다. 이 내부 기록은 일반 채팅 목록에서 숨기고 대시보드 사용량 카드에는 마지막 전송 시각과 감지 사유를 표시한다. Codex 초기화권은 `/usage`의 Full reset 상세와 공식 app-server 응답을 하루 1회 확인해 잔여 개수·가장 이른 기한을 저장하고, 중간 조회가 기한 없는 개수만 반환해도 마지막 정상 기한을 보존. 관리자는 대시보드 확인창을 거쳐 해당 계정 카드의 맨 위 Full reset 초기화권을 공식 app-server 메서드로 사용할 수 있고, 서버가 계정·실제 잔여량·중복 요청·결과를 다시 검증한다. 대시보드에 마지막 파싱 시각·Codex 초기화권·카드별 새로고침 버튼(즉시 일반 사용량 재조회 요청)을 표시하고, CLI가 옛 스냅샷을 돌려줘 같은 창의 사용량이 뒤로 후퇴하면 마지막 정상값을 유지한 채 stale로만 표시하되, 같은 거부가 5회(약 5분) 연속되면 그 값이 실제 최신값이라고 보고 채택해 오래된 값이 무기한 굳지 않게 함
- CPU·메모리·디스크·네트워크·프로세스·채팅 상태 대시보드(프로세스는 채팅 하나에 딸린 tmux·node·CLI를 한 줄로 묶고 web-agent-manager 시스템 프로세스와 그 밖의 프로세스를 구분해 접어서 표시, 컬럼 클릭으로 정렬). 채팅 묶음의 `터미널 종료`는 개별 PID 신호가 아니라 채팅 세션의 정상 종료 API를 사용해 tmux·상태·리밋 재개 대기를 함께 정리하며, 펼친 행에서는 진단용 개별 종료·강제 종료를 계속 제공. 채팅이 아닌 기타 묶음은 속한 프로세스 전부에 신호를 보내되 실행 전 대상 목록을 확인창에 보여줌. web-agent-manager 시스템 묶음은 서버 본체와 이를 띄운 watch 프로세스가 들어 있어 화면에 종료 버튼을 두지 않고 API 요청도 거부함. CPU·메모리·네트워크는 5초, 프로세스와 tmux 연결은 15초, 디스크는 60초로 비용별 수집 주기를 분리하고 웹소켓 실시간 반영과 1분 주기 화면 안전망 새로고침 제공
- 런타임 CLI 버전은 서버 시작 시 한 번만 조회해 화면 새로고침과 실시간 갱신에서 `claude --version`·`codex --version` 프로세스를 반복 실행하지 않음
- 장기 세션의 수십 MB JSONL은 최초 한 번만 전체 파싱하고 이후 추가된 레코드만 증분 반영하며, 터미널 상태는 headless 화면에서 공유 판정해 반복 `tmux capture-pane` 프로세스와 일시 메모리 사용을 제한
- 관리자만 대시보드에서 Slack bot token·channel id와 ntfy topic·서버 URL을 각각 저장(DB 우선, 없으면 환경변수로 대체)하고 테스트 메시지 전송 가능 — 작업 완료·권한 요청·사용량 한도 도달/초기화·터미널 종료 알림이 등록된 채널 전부(Slack·ntfy 동시)에 전송됨
- 웹소켓 연결이 끊기면 자동 재연결하고 연결이 열릴 때마다 채팅 목록·현재 메시지를 서버 기준으로 재동기화해 끊긴 사이 놓친 작업 상태 이벤트를 복구, 모바일에서 앱이 백그라운드 후 다시 보일 때도 최신 상태를 강제로 재조회(새로고침 없이 복구)
- 채팅 선택은 사용자가 직접 고른 채팅을 단일 기준으로 유지하고, 이전 채팅에서 늦게 끝난 목록·메시지·URL 복원 응답은 선택 버전 검사로 폐기한다. 선택·목록 재조회·전송·실시간 이벤트 흐름은 클라이언트 `[web-agent-manager:chat]`와 서버 `[web-agent-manager:chat:server]` 로그로 추적 가능
- 서버·클라이언트 상세 로그를 데이터 디렉터리 `logs/`에 날짜별 파일(`server-날짜.log`, `client-날짜.log`)로 저장 — 서버는 콘솔 출력 전부와 API 요청(메서드·경로·상태·소요시간·사용자)·프로세스 오류를, 클라이언트는 콘솔 로그와 전역 오류를 로그인 후 배치 전송으로 남기며 14일 지난 파일은 자동 정리(`WEB_AGENT_MANAGER_LOG_LEVEL`로 레벨 조정). 문제 추적용 임시 상세 로그로 상태 판정(작업중·승인·모델·권한 모드·사용량 파싱)의 터미널 스냅샷 원본과 판정 결과, 클라이언트 API 호출·웹소켓 수신 인/아웃 전체도 debug 레벨로 기록(같은 화면·같은 판정 반복은 생략, 비밀 값은 마스킹)
- 프로젝트/전역 `AGENTS.md`, `CLAUDE.md` 전용 편집, `CLAUDE.md`가 `AGENTS.md`를 import하도록 보장하는 공통 지침 옵션
- 총량·파일 수·시간·동시 요청·디스크 여유 한도를 적용한 프로젝트 파일 업로드와 원자적 덮어쓰기 정책, 단일 다운로드, 텍스트로 미리볼 수 있는 파일의 웹 편집·저장(관리자 전용, 임시 파일 rename 교체로 원본 권한 유지), 파일·폴더 삭제(하위 내용 포함, 관리자·신뢰 네트워크 전용, `.git` 등 민감 경로는 신뢰 네트워크라도 이 화면에서 지울 수 없음), symlink를 제외한 조밀한 리스트형 탐색기. 신뢰 네트워크에서만 일반 점 파일을 표시하며 Markdown(GFM)·sandbox HTML·이미지·영상·오디오·PDF·일반 텍스트 형식별 미리보기와 ZIP·EPUB 압축파일 안내를 제공하고, 모바일 미리보기는 선택 즉시 화면 상단 전용 오버레이로 표시
- 등록 프로젝트에 `web-agent-manager-session-context`와 `web-agent-manager-delegate` 스킬을 Codex·Claude용으로 자동 연결하고, 소유자 전용 Unix 소켓·stdio MCP/CLI로 채팅 번호 또는 프로젝트별 세션 문맥 조회, 7일 스냅샷, 멱등 작업 전달, 새 자식 채팅 생성, 완료 대기·응답 회수를 지원. 명시적 위임과 복잡한 구현·보안 교차검증에 한정해 Claude와 Codex가 서로를 자식 작업자로 호출하고 부모가 결과를 검토해 이어서 작업할 수 있음
- Agent Lab은 하나의 명령을 모델·스킬·권한·하네스·훅·예산 조건별 Variant로 저장하고 품질·성공률·벽시계 시간·토큰·비용·종료 상태를 비교한다. `Single`은 현재 설치 custom skills/공급자 built-in 기준선 각각에 선택 스킬을 더한 네 조건을 실행별 read-only native bundle로 만들고, 같은 비교 그룹의 모델·reasoning·권한·하네스·훅·예산·스킬 활성화 방식·Git HEAD를 고정한다. Claude는 자동 발견 외에 두 arm이 동일한 무상태 `SessionStart` 훅을 거치고 처리군에만 추가 스킬 본문을 넣는 강제 활성화를 선택할 수 있어, 훅 기반 스킬을 전역 설정 쓰기 없이 비교한다. `Orchestrator → Workers`, `Evaluator → Optimizer`는 primary/secondary Codex·Claude 모델, worker·반복·점수·무개선 한도와 내장 hook을 detached worktree에서 실행한다. 완료 run은 공급자별 CLI capability를 지키는 복수 evaluator의 블라인드 judgment와 `partial`을 보존하며, 우승 run은 accepted 사람 판정과 지표·경고를 포함한 불변 Agent preset 새 버전으로 승격한다. graph 공급자별 스킬 overlay, pairwise·통계 자동 반복과 일반 채팅 preset 실행은 후속 범위다. 전체 구조와 한계는 [에이전트 실험실 설계 문서](docs/agent-lab.md)에 정리한다
- 관리자는 채팅 헤더의 서브 에이전트 패널에서 현재 채팅을 부모로 한 새 Codex·Claude 자식 채팅을 만들고, 위임 작업과 실제 대상 상태를 확인하며 해당 채팅 열기·응답 중단·터미널 종료·재시작을 수행. 생성 폼은 `새 작업`을 눌렀을 때만 펼쳐지고 목록은 상태·최근 갱신·명시적 제어 버튼 중심으로 표시
- 서버 시작 시 Codex·Claude CLI의 전역 스킬·web-agent-manager MCP 연동을 한 번만 확인하고, 정상 상태는 DB에 저장해 이후 시작과 API 조회에서 CLI 검사를 생략. 실패한 공급자만 관리자 연결 버튼을 표시하며 이미 연동된 상태에서 버튼을 눌러도 제거·재등록 없이 성공 처리
- 관리자 헤더의 키 버튼에서 Codex device auth, Claude 계정 로그인, GitHub web auth를 공식 CLI PTY로 실행하고 인증 URL을 새 탭으로 열기. 인증 상태 명령은 서버 시작 시 한 번과 로그인 PTY 종료 직후에만 실행하고 결과를 메모리에 유지하며, 토큰·CLI 설정 내용은 WAM API나 DB로 전달하지 않음
- Codex·Claude·Grok은 인증 계정을 여러 개 등록해 채팅마다 다른 계정으로 실행할 수 있다(한 계정의 사용량 한도가 차면 다른 계정으로 새 채팅을 시작하는 용도). 인증 파일을 백업·교체하는 방식이 아니라 각 CLI가 공식 지원하는 설정 디렉터리 환경변수(Claude `CLAUDE_CONFIG_DIR`, Codex `CODEX_HOME`, Grok `GROK_HOME`)로 계정을 나누므로, 계정마다 로그인이 독립적이고 서로의 인증을 건드리지 않는다. 기본 계정은 환경변수를 주입하지 않아 기존 `~/.claude`·`~/.codex`·`~/.grok` 인증을 그대로 쓰며, 추가 계정만 앱 데이터 디렉터리 아래 전용 폴더(`agent-accounts/<공급자>/<슬러그>`, 소유자 전용 권한)를 새로 만든다. WAM은 어느 경우에도 인증 파일 내용을 읽지 않고 CLI 상태 명령의 종료 코드만 확인한다
- 계정 관리는 CLI 인증 팝업에서 공급자별로 추가·이름 변경·삭제하고, 계정마다 로그인 상태와 그 계정으로 만든 채팅 수를 함께 표시한다. 계정이 둘 이상인 공급자는 새 채팅 버튼이 계정별로 나뉘어(`+ Claude · 회사 계정`) 어떤 인증으로 시작할지 고를 수 있고, 정지된 채팅은 헤더의 선택 상자로 계정을 옮길 수 있다 — 환경변수는 tmux 세션을 만들 때만 적용되므로 실행 중인 채팅은 거부하며, 계정을 옮기면 그 계정 폴더에 없는 세션을 재개하려다 실패하지 않도록 세션 연결을 끊고 다음 시작부터 새 대화로 진행한다(기록 파일은 지우지 않아 계정을 되돌리면 다시 이어갈 수 있음). 계정을 지울 때는 그 계정을 쓰는 채팅이 남아 있으면 거부하고, 인증이 든 폴더까지 지울지는 따로 확인받는다(되돌릴 수 없는 작업이라 신뢰 네트워크에서만 허용)
- 채팅 기록은 계정마다 저장 경로가 갈라지므로 등록된 모든 계정의 기록 루트를 함께 스캔하고, 발견한 세션은 그 파일이 실제로 놓인 계정에 귀속시킨다. 사용량 조회는 계정마다 상태 PTY가 하나씩 상시 실행되어 비용이 크므로 기본값은 기본 계정만 조회하고, CLI 인증 팝업의 `사용량 조회` 설정에서 모든 계정으로 넓힐 수 있다(범위를 바꾸면 빠진 계정의 PTY와 저장된 상태를 정리하고 새 계정의 PTY를 띄운다). 한도 대기 후 자동 재개도 그 채팅이 실제로 쓰는 계정의 사용량을 기준으로 판단한다
- 도구 탭에서 Claude/Codex별 commands·skills·marketplace·MCP 카탈로그 확인, Claude 프로젝트 `.mcp.json`과 Codex 사용자/프로젝트 `config.toml` 기반 MCP 추가·수정·삭제·Codex 활성화 토글 관리, provider CLI가 보고하는 연결 상태 전용 MCP도 read-only로 표시(기존 env/header 값은 웹에 표시하지 않고 키 이름만 표시). 최초 카탈로그 응답 전에는 로딩 스피너를 표시하고 성공 응답 후에만 항목 없음 안내를 표시
- Android 6 이상 WebView 앱에서 기존 반응형 웹 UI와 로그인 세션·파일 첨부/다운로드를 사용하고, 1×1(Claude/Codex 스와이프)·2×1·1×2·2×2(두 모델+CPU+RAM)로 크기에 맞춰 바뀌는 홈 화면 위젯과 수동/30분 주기 갱신을 제공. Firebase 자격증명을 나중에 배치하면 기존 작업 완료·권한 요청·한도·터미널 알림을 FCM 앱 푸시로 함께 전송
- 로컬·깃허브·저장소 탭(프로젝트가 선택돼 있으면 로컬 탭으로 열림), 저장소 상태·GitHub 이슈/PR/Actions 조회는 서버에 캐시해 탭 진입 즉시 표시하고 화면이 보이는 동안 1분 주기로 자동 갱신하며(헤더에 기준 시각 표시), 새로고침 버튼은 캐시를 건너뛰고 커밋·push·브랜치 전환 등 쓰기 작업 뒤에는 캐시를 즉시 버림. diff는 GitHub 화면을 기준으로 렌더링한다 — `diff --git`·`index`·`new file mode`·`--- /dev/null` 같은 원문 헤더는 파싱 단계에서 상태 배지(추가됨·삭제됨·이름 변경·수정됨)와 경로·증감 통계로 흡수해 화면에 노출하지 않고, hunk 사이 바뀌지 않은 구간은 `N줄 펼치기`로 원본을 불러와 GitHub처럼 펼쳐 볼 수 있다. 파일별 카드는 접었다 펼 수 있고 이전·이후 줄 번호를 함께 표시하는 통합/분할 보기를 선택한다. 좁은 화면에서는 변경 파일·커밋 사이드바를 접어 diff부터 보여주고, 줄 번호를 이후 파일 기준 하나만 남겨 코드 폭을 넓히며, 파일 경로는 디렉터리 쪽만 줄이고 파일명은 끝까지 보여준다(분할 보기는 최소 폭을 두고 가로 스크롤). 파일 확장자에 맞는 밝은·어두운 문법 색상을 코드 본문에 적용하며, Shiki 코어와 해당 언어 문법은 diff를 실제로 열 때만 불러옴. 대용량 PR diff는 파일 목록만 먼저 표시하고 펼친 파일의 줄 DOM만 지연 렌더링. GitHub 탭은 확인 전용이라 실제 브랜치를 바꾸지 않는다 — 현재 브랜치는 표시만 하고 전환 UI는 채팅 화면에만 두므로 터미널이 실행 중이어도 조회가 막히지 않는다. Diff 화면 상단에서 조회할 작업공간을 직접 골라(공유 checkout·채팅 전용 worktree·다른 폴더로 빼둔 외부 worktree) 그 기준의 커밋 내역·미커밋 변경·diff를 보고, 커밋 내역만 다른 브랜치 기준으로도 볼 수 있다. 목록에는 그 프로젝트 저장소에 등록된 worktree만 나오며(무관한 저장소는 보이지 않음), 기본값이 아닌 작업공간·브랜치를 보는 동안에는 커밋·push를 막는다 — 쓰기는 채팅 기준 경로로 나가기 때문에 보고 있는 변경과 실제 커밋 대상이 어긋날 수 있어서다 — 경로는 `git worktree list`가 보고하는 그 프로젝트의 실제 목록과 대조해 검증하므로 임의 경로 조회는 거부한다. 최근 커밋을 클릭하면 그 커밋의 작성자·시각·본문과 변경된 파일 목록이 먼저 나오고 파일별 diff만 따로 보며(커밋 시점 기준으로 컨텍스트 펼치기), 커밋·push와 GitHub 이슈·PR 목록/상세/생성/댓글/닫기/다시 열기/리뷰/병합, Actions 재실행 관리(일부 gh 조회 실패 시 가능한 목록은 유지하고 영역별 오류 표시). GitHub 최초 조회 전에는 로딩 스피너, 응답 후에는 인증 필요 또는 이슈·PR·워크플로별 기록 없음 상태를 구분해 표시. 워크플로 목록은 Actions 탭을 실제로 열 때만 조회한다(가장 느린 조회라 함께 부르면 탭 진입이 그만큼 늦어짐). 이슈·PR 상세도 서버에 캐시해 같은 항목을 다시 열면 즉시 표시한다. 커밋·이슈·PR·워크플로 목록은 처음에 각각 30·50·50·20개까지 불러오고, 뒤에 더 있으면 목록 끝의 `더 보기`로 한 묶음씩 이어서 불러온다 — 커밋이 수천 개인 저장소에서도 첫 화면이 느려지지 않도록 한 번에 전부 읽지 않으며, 커밋 더 보기는 GitHub 목록을 다시 읽지 않고 그 반대도 마찬가지다. 좁은 화면에서 커밋을 고르면 길어진 목록을 자동으로 접고 커밋 상세로 이동하며, 커밋 설명은 안쪽에서 따로 스크롤되지 않고 페이지 흐름을 따라 이어진다
- 이슈 상세의 `새 작업공간에서 시작`(또는 로컬 탭의 `새 작업공간`)으로 전용 worktree와 그 작업용 새 채팅을 함께 만든다 — GitHub가 이슈에 연결해 둔 브랜치가 있으면 그 브랜치를 그대로 체크아웃하고, 없으면 `issue-<번호>-<제목 슬러그>`를 제안해 확인창에서 고칠 수 있다. 현재 채팅이 다른 worktree에 묶여 있어도 새 채팅을 만들기 때문에 영향을 주지 않는다. worktree 폴더는 브랜치 기준이라 같은 브랜치를 고르면 여러 채팅이 한 폴더를 공유하며(같은 작업에 Claude와 Codex를 나란히 둘 수 있음), 작업이 끝나면 `정리` 버튼으로 worktree를 제거한다 — 실행 중인 채팅이 있으면 거부하고, 미커밋 변경이 남아 있으면 한 번 더 확인한 뒤에만 지우며, 채팅 자체는 남기고 작업공간 연결만 끊는다. 채팅이 전용 worktree를 쓰면 파일 탭·미리보기·업로드·편집과 지침 편집도 모두 그 worktree 폴더를 기준으로 동작하고, worktree에서 만든 대화 기록도 별도 프로젝트로 새지 않고 원본 프로젝트에 귀속된다. 새 worktree를 만들 때는 git에 올리지 않는 로컬 지침(`CLAUDE.local.md`·`AGENTS.override.md`·`.claude/CLAUDE.md` 등)을 원본 checkout에서 복사해 Claude·Codex가 같은 지침으로 동작하게 하며, 커밋되어 체크아웃된 지침은 덮어쓰지 않는다. 저장소 탭에서 인증 계정과 소속 조직별 저장소를 검색하고 확인 팝업에서 clone 경로를 지정해 프로젝트 생성. 같은 origin의 프로젝트가 이미 있으면 중복 clone 없이 기존 프로젝트 채팅으로 이동하며, 로컬 프로젝트 등록 시 새 GitHub 저장소 생성·공개 범위·설명·origin 연결을 함께 선택 가능
- 로컬 diff는 변경 파일을 직접 선택한 뒤에만 해당 파일 범위로 조회·표시하며, 아무 파일도 고르지 않은 상태에서는 전체 diff를 자동으로 노출하지 않는다. 수정·추가·삭제 파일을 여러 개 함께 선택해도 모두 표시하고 조회 실패 원인을 빈 diff로 숨기지 않는다. 변경 파일 목록은 바로 위 폴더로 묶여 폴더 체크박스로 그 안 파일을 한 번에 선택할 수 있고, "선택 파일 롤백"으로 선택한 파일·폴더의 미커밋 변경을 되돌린다(수정·삭제된 추적 파일은 마지막 커밋 내용으로, 아직 커밋 안 한 새 파일·untracked 파일은 삭제 — 커밋 손실과 같은 급으로 되돌릴 수 없어 관리자·신뢰 네트워크에서만 허용하고 실행 전 확인)
- Slack·ntfy 승인 요청·작업 완료·비정상 종료·사용량 한도 초기화 알림. Claude 현재 세션·전체 모델 주간 창과 Codex 대표 주간 창은 예정 초기화 시각 1분 뒤 사용량 재확인 없이 각각 알리고, 정기 조회에서 새 창 전환이 먼저 감지되면 즉시 알림. 작업 완료·한도/세션 초기화 시 브라우저 알림(헤더에서 권한 요청)
- 사용량 한도(rate limit)에 걸리면 "재설정까지 대기"를 사람 개입 없이 자동 선택(Claude의 예전 `Enter selection [1-2]` 형식과 최신 제목·wait/upgrade 선택지·공통 푸터 형식을 모두 감지)하고, 선택 메뉴 없는 Claude 리밋 배너는 뒤에 후속 대화가 없는 최신 화면일 때만 대기로 등록함. Codex의 `try again at` 시각은 절대 재개 시각으로 저장해 실제 초기화 후 실행 중인 터미널에만 "계속"을 보내 하던 작업을 자동으로 이어감. 사용자가 터미널을 종료하면 대기를 취소하며 종료된 세션을 자동으로 다시 시작하지 않음
- 설정한 시간(기본 24시간) 동안 아무 활동이 없는 채팅 터미널을 10분 주기로 자동 종료. 관리자가 대시보드에서 켜고 끄거나 기준 시간(1~720시간)을 조정하며, 작업 중이거나 리밋 재개를 기다리거나 승인 응답을 기다리는 채팅은 유휴 시간과 무관하게 종료하지 않음. 종료 사실은 알림 없이 감사 로그(`chat.idle_auto_stop`)에 시스템 주체로 기록
- 되돌릴 수 없는 작업(채팅 삭제, 세션 백업 삭제, 프로젝트 삭제, worktree 정리, 프로세스 종료, MCP 삭제)은 관리자여도 신뢰 네트워크에서만 허용한다 — 외부 접속에서는 403으로 거부하고 조회는 그대로 동작한다. 대역 설정은 파일 탭의 숨김 경로 정책과 같은 `WEB_AGENT_MANAGER_TRUSTED_NETWORKS`를 쓴다
- 로그인 세션, CSRF, 경로/symlink 검증, 감사 로그

## 화면

| Claude·Codex 서브 에이전트 작업 관리 | Markdown 등 형식별 파일 미리보기 |
| --- | --- |
| ![서브 에이전트 작업 상태와 제어](artifacts/ui-subagent-manager.png) | ![파일 목록과 Markdown 미리보기](artifacts/ui-file-markdown-preview.png) |

| GitHub PR 통합·분할 diff | 사용량 원본 화면과 운영 지표 |
| --- | --- |
| ![GitHub PR 분할 diff](artifacts/ui-pr-diff-split.png) | ![사용량 원본 화면과 운영 대시보드](artifacts/ui-usage-snapshot.png) |

| GitHub 저장소 프로젝트 목록 | 로컬 프로젝트와 GitHub 저장소 동시 생성 |
| --- | --- |
| ![GitHub 저장소 연결 상태와 프로젝트 이동](artifacts/ui-github-repositories.png) | ![로컬 프로젝트 GitHub 저장소 생성 옵션](artifacts/ui-project-create.png) |

| GitHub 저장소 프로젝트 생성 팝업 | CLI 인증 팝업 |
| --- | --- |
| ![조직 저장소와 clone 경로를 확인하는 프로젝트 생성 팝업](artifacts/ui-github-project-popup.png) | ![Codex Claude GitHub CLI 인증 팝업](artifacts/ui-cli-auth-popup.png) |

## 개발 구조

프론트엔드는 `src/client/main.tsx`가 최상위 상태와 실시간 연결을 조정하고, 화면 단위 구현은 `src/client/features/*` 아래에 둔다. 공통 API 호출은 `src/client/api.ts`, 표시·승인·포맷 유틸은 `src/client/lib/*`, 클라이언트 공통 타입은 `src/client/types.ts`를 사용한다. 공급자별 TUI 준비/작업중 판정, 사용량 파싱, 모델 메뉴 조작, slash 명령 특례, 표시 라벨과 대표 사용량 창은 `ProviderAdapter` 구현에 둔다. Claude 파서는 screen-reader 출력과 일반 TUI 출력의 시작 배너, placeholder 프롬프트, 대형 세션 resume 선택 화면, `/model`, `/usage`, `/effort` 확인 형식을 모두 처리한다. 클라이언트의 공급자 버튼·라벨·대표 사용량 구간은 `/api/providers` 응답을 기준으로 렌더링한다. 주요 파일 역할은 `CODETREE.md`를 기준으로 확인한다.

공식 Codex/Claude CLI·데스크톱 앱 대비 남은 구현 후보는 `TODO_LIST.md`에 정리한다.

의존성 업데이트는 Dependabot이 매주 npm 운영·개발 패키지와 Docker Actions를 호환 범위별 그룹 PR로 제안한다. Node Docker 이미지는 지원 기준인 22 계열을 유지하고, TypeScript와 better-sqlite3 주요 버전 자동 PR은 제외한다. 이 세 가지 주요 버전 변경은 별도 호환성 및 배포 검증 후 직접 반영한다.

## 기준 환경

- Linux x86_64 또는 macOS x64/arm64
- Windows는 WSL2 x86_64
- Node.js 22 이상
- Codex CLI 0.146.0
- Claude Code 2.1.231
- tmux 3.4
- Git 및 GitHub CLI

CLI 인증은 앱이 토큰을 받는 방식이 아니다. 관리자가 헤더의 키 버튼을 누르면 서비스 사용자 권한으로 `codex login --device-auth`, `claude auth login --claudeai`, `gh auth login --web` 공식 흐름을 PTY에서 시작한다. 화면에는 CLI 출력과 인증 URL만 중계하고 토큰·CLI 설정 파일 내용은 읽거나 DB에 저장하지 않는다.

## 설치

### Docker

Docker만 설치된 Linux 서버에서는 앱과 Node.js 22, tmux, Git, GitHub CLI, Codex CLI, Claude Code가 함께 들어 있는 이미지를 사용할 수 있다.

```bash
docker compose up -d --build
```

`http://localhost:4317`에 접속해 첫 관리자 계정을 만든다. 로그인하면 인증되지 않은 CLI의 인증 관리 창이 자동으로 열리며, 이후 상단 연동 알림에서 Codex·Claude 전역 스킬과 `web-agent-manager` MCP를 연결할 수 있다. GitHub 인증을 마치면 GitHub 탭의 저장소 목록에서 프로젝트를 바로 만들 수 있다.

Compose는 WAM DB·로그를 `wam-data`, clone 프로젝트를 `wam-projects`, 세 CLI의 사용자 설정을 `wam-home` 볼륨에 보존한다. 호스트 프로젝트를 직접 노출하려면 `wam-projects:/workspace`를 `/호스트/경로:/workspace` bind mount로 바꾸되 컨테이너 서비스 UID `10001`의 읽기·쓰기 권한을 준비해야 한다. Docker socket과 `privileged` 권한은 사용하지 않는다. 외부 주소로 서비스할 때는 `WEB_AGENT_MANAGER_PUBLIC_URL`을 실제 HTTPS origin으로 지정한다.

태그와 `main` push는 `.github/workflows/docker-image.yml`에서 linux/amd64·linux/arm64 이미지를 빌드해 `ghcr.io/<소유자>/web-agent-manager-app`에 게시한다. builder는 런타임 `/app`과 구분되는 전용 경로를 사용해 공개 산출물의 빌드 머신 절대 경로 검사를 유지한다. Actions 저장 공간이 빌드마다 누적되지 않도록 Docker 캐시는 최종 이미지 레이어 중심의 `mode=min`으로 내보내고 별도 Buildx 기록 아티팩트는 만들지 않는다.

### v0.4.0 압축 배포

`npm run release:package`는 production 빌드와 CycloneDX SBOM, SHA-256 체크섬을 포함한 다음 배포 파일을 `release/archives/`에 만든다.

- `web-agent-manager-v0.4.0-linux-x64.zip`
- `web-agent-manager-v0.4.0-macos-x64.zip`
- `web-agent-manager-v0.4.0-macos-arm64.zip`
- `web-agent-manager-v0.4.0-windows-wsl-x64.zip`
- `web-agent-manager-sbom.cdx.json`
- `SHA256SUMS`

압축 해제 후 Linux는 `./setup.sh`, macOS는 `setup.command`, Windows는 `setup-windows.cmd` 하나만 실행하면 production 의존성 설치, 관리자 생성, Codex·Claude 스킬/MCP 연결 확인 후 서버 실행까지 이어진다. 고급 운영에서는 기존 `install`, `create-admin`, `run` 스크립트를 단계별로 사용할 수 있다. Windows는 tmux와 Unix socket 의존성 때문에 WSL2 진입점으로 동작한다. 각 대상 OS에 Node.js 22 이상과 tmux가 먼저 설치돼 있어야 하며, 설치 스크립트가 해당 OS에서 native Node 의존성을 설치한다.

### Electron 데스크톱

Linux·macOS Electron 패키지는 production 서버와 같은 웹 UI를 포함해 기능이 분기되지 않는다. 첫 실행에서 관리자 계정을 만들고, 설치된 Codex·Claude CLI가 있으면 스킬과 `web-agent-manager` MCP 연결도 자동 보정한다. 시스템 Node.js 22 이상과 tmux는 필요하다.

```bash
npm run desktop
npm run desktop:package
```

설치 파일은 `release/desktop/`에 생성된다. `.github/workflows/release-desktop.yml`은 태그 또는 수동 실행 시 Linux x64 AppImage·deb, macOS Intel x64·Apple Silicon arm64 dmg·zip, Windows x64 NSIS·portable을 각 운영체제 runner에서 빌드한다. macOS는 네이티브 모듈 아키텍처를 보장하기 위해 Intel과 Apple Silicon runner를 분리하며, 태그 빌드는 GitHub 자산 이름에 맞게 공백을 점으로 정규화하고 파일명의 중복을 검사한 뒤 해당 GitHub Release에 산출물과 전체 체크섬을 자동 첨부한다. Release에 복사된 뒤 중복이 되는 Actions 중간 아티팩트는 1일만 보존한다. Windows Electron은 네이티브 tmux 백엔드를 포함하지 않으므로 `setup-windows.cmd`로 실행한 WSL2 서버 또는 `WEB_AGENT_MANAGER_SERVER_URL`로 지정한 기존 서버를 여는 데스크톱 셸이다. 현재 데스크톱 산출물에는 플랫폼 코드 서명을 적용하지 않으므로 운영체제의 미확인 게시자 경고가 표시될 수 있다.

### Android WebView 앱

`android/`는 서버와 별도로 설치하는 Android 6(API 23) 이상 클라이언트다. 첫 실행에서 web-agent-manager 서버 주소를 입력하면 기존 웹 로그인과 모바일 UI를 그대로 사용한다. 상태바·화면 컷아웃·하단 내비게이션바·화면 키보드의 실제 여백은 네이티브 Activity가 반영해 웹 헤더·채팅 입력창과 겹치지 않게 한다. 설정 톱니는 드래그하면 가까운 좌우 가장자리에 붙고 위치를 저장하며, 길게 누르거나 설정의 `설정 버튼 숨기기`를 선택하면 작은 가장자리 복원 탭으로 접힌다. 동일 서버에서 내려받은 파일은 로그인 쿠키를 유지한 채 시스템 공용 `Downloads` 폴더에 저장해 `내 파일 > 다운로드`에서 바로 확인할 수 있다. HTTPS는 모든 호스트에 허용하고, 평문 HTTP는 앱 코드에서 loopback·RFC1918·CGNAT(Tailscale 포함)·IPv6 ULA/link-local·`.local`·`.lan` 주소로 제한한다. 인증서 오류를 무시하는 코드는 없으며 설정 서버 밖 링크는 시스템 브라우저로 연다.

Android 앱 버전은 서버 패키지와 같은 `0.4.0`이다. CI는 공식 Gradle wrapper JAR과 배포 ZIP 체크섬을 검증한 뒤 API 36에서 debug·release 빌드와 lint를 실행한다. Android 소스와 Gradle 구성은 저장소에 포함하지만 공개 GitHub Release에는 서명 APK를 자동 첨부하지 않는다. 기본 `assembleRelease` 결과는 서명되지 않으며 실제 배포 APK는 운영자가 별도 release signing 환경에서 생성해야 한다. keystore·비밀번호·Firebase 설정 파일은 저장소와 릴리즈 자산에 포함하지 않는다.

```bash
cd android
./gradlew assembleDebug
```

설치 가능한 개발 APK는 `android/app/build/outputs/apk/debug/app-debug.apk`에 생성된다. 배포용 release APK는 별도 Android 서명 키를 사용하도록 로컬/CI 서명 설정을 추가한 뒤 `./gradlew assembleRelease`로 만든다. 서명 키와 `google-services.json`은 저장소에 커밋하지 않는다. 자세한 빌드·FCM 절차는 [android/README.md](android/README.md)를 따른다.

홈 화면에 `웹 에이전트 관리자` 위젯을 추가하면 크기에 따라 다음처럼 바뀐다.

- 1×1: Claude·Codex 중 한 모델을 표시하며 위아래 스와이프로 전환
- 2×1: Claude·Codex 사용량을 좌우로 표시
- 1×2: Claude·Codex 사용량을 위아래로 표시
- 2×2 이상: Claude·Codex 사용량과 서버 CPU·RAM 사용률 표시

위젯은 WebView의 로그인 쿠키로 읽기 전용 `/api/mobile/widget`을 호출한다. 앱에서 먼저 로그인해야 하며, 30분 주기와 `↻` 버튼·페이지 로드 시점에 갱신한다.

`.env`가 포함된 숨김 파일 열람·프로세스 종료·삭제 같은 내부망 전용 기능을 외부에서도 사용하려면 먼저 내부망 또는 VPN 주소에서 관리자 로그인 후 설정의 `이 기기 앱 인증`을 누른다. 서버는 Android Keystore의 P-256 공개키만 등록하고, 앱에서 외부 HTTPS URL로 바꾸면 2분짜리 1회성 challenge와 실제 접속 origin을 함께 서명해 그 origin에 새 HttpOnly 웹 세션을 발급하면서 내부망 capability를 함께 부여한다. 내부 URL의 쿠키·개인키·로그인 비밀번호·영구 bearer 토큰은 외부 주소나 WebView로 복사하지 않는다. 사용자가 명시적으로 로그아웃한 뒤에는 자동 재로그인하지 않으며, 설정에서 `연결`을 다시 누르면 해당 주소의 기기 로그인을 한 번 재시도한다. 필요 없어진 기기는 설정의 `이 기기 인증 해제`로 모든 세션 권한을 즉시 회수한다.

### 소스 설치

```bash
npm ci
npm run build
```

`.env.example`을 참고해 systemd의 `EnvironmentFile` 또는 실행 환경에 설정한다. `WEB_AGENT_MANAGER_PROJECTS_DIR`은 GitHub 저장소의 기본 clone 경로이고, 프로젝트 등록은 관리자 전용 기능이라 기본적으로 경로 제한이 없다. 특정 디렉터리로만 제한하고 싶을 때만 `WEB_AGENT_MANAGER_ALLOWED_ROOTS`에 쉼표로 구분해 등록한다. 외부 접속 시에는 HTTPS reverse proxy를 사용하고 `WEB_AGENT_MANAGER_PUBLIC_URL`을 대표 origin과 일치시킨다. 여러 외부 Host를 함께 쓰면 프록시가 원래 프로토콜을 `X-Forwarded-Proto`로 전달해야 WebSocket Origin 검증이 같은 HTTPS 연결로 판정한다.

이전 이름으로 설치한 환경은 기존 `MYAGENT_*` 변수를 계속 읽지만 새 `WEB_AGENT_MANAGER_*` 값이 있으면 이를 우선한다. 기존 로그인 쿠키와 `.myagent-uploads` 첨부 경로도 읽기 호환하며, 새 세션·첨부·tmux·소켓·MCP 등록에는 `web-agent-manager` 이름만 사용한다.

파일 탭의 점 파일과 `.env`·`.git` 같은 민감 경로는 요청마다 접속 주소를 다시 판정해 신뢰 네트워크에서만 표시한다. 기본 대역은 loopback, RFC1918, CGNAT `100.64.0.0/10`, IPv6 ULA·link-local이며 `100.*` 전체를 허용하지 않는다. 추가 VPN 대역은 `WEB_AGENT_MANAGER_TRUSTED_NETWORKS`에 CIDR을 쉼표로 지정한다. reverse proxy를 사용할 때는 프록시 자체 주소만 `WEB_AGENT_MANAGER_TRUSTED_PROXIES`에 명시해야 전달된 클라이언트 주소를 신뢰한다. 이 값을 설정하지 않으면 프록시 뒤의 요청은 접속 주소가 항상 프록시 자신(로컬)으로 보여 외부 접속까지 내부망으로 오판정되므로, `X-Forwarded-For`·`Forwarded`·`X-Real-IP`·`CF-Connecting-IP`·`True-Client-IP` 중 하나라도 붙은 요청은 내부망으로 보지 않는다. 즉 도메인으로 들어오는 접속은 기본적으로 외부망이고, 내부망 기능은 `192.168.x.x` 같은 주소로 직접 접속할 때만 열린다.

`WEB_AGENT_MANAGER_TRUSTED_PROXIES` 지정은 "이 프록시를 거친 요청을 통과시킨다"는 뜻이 아니라 "이 프록시가 전달한 방문자 주소를 믿는다"는 뜻이다. 지정하면 판정 근거가 프록시 주소에서 `X-Forwarded-For`의 실제 방문자 주소로 바뀔 뿐이라, 도메인 접속은 방문자 주소가 공인 IP이므로 여전히 외부망이다. 도메인 경유로도 내부망 기능을 열려면 `WEB_AGENT_MANAGER_TRUSTED_PROXIES`(프록시 주소)와 `WEB_AGENT_MANAGER_TRUSTED_NETWORKS`(허용할 공인 IP)를 모두 지정해야 하는데, 그 공인 IP를 공유하는 모든 기기가 민감 경로에 접근하게 되고 가정용 회선은 주소가 바뀌므로 권장하지 않는다. 또한 `WEB_AGENT_MANAGER_TRUSTED_PROXIES`를 실제 프록시보다 넓게 잡으면 `X-Forwarded-For`를 위조해 내부망 판정을 얻을 수 있으므로 주소를 정확히 적는다.

관리자 계정은 비밀번호 값을 명령 인자로 넘기지 않고 환경변수로 전달해 생성한다.

```bash
export WEB_AGENT_MANAGER_ADMIN_USERNAME='관리자 아이디'
export WEB_AGENT_MANAGER_ADMIN_PASSWORD='12자 이상의 비밀번호'
npm run admin:create
unset WEB_AGENT_MANAGER_ADMIN_PASSWORD
```

개발 서버:

```bash
npm run dev
```

Vite 개발 서버에 별도 도메인으로 접근할 때는 `WEB_AGENT_MANAGER_DEV_ALLOWED_HOSTS`에 쉼표로 구분해 추가한다. 선행 점이 있는 값(예: `.example.com`)은 루트 도메인과 하위 도메인을 함께 허용하며, `localhost`와 IPv4·IPv6 리터럴 주소는 Vite 기본 정책을 따른다.

프로덕션 서버:

```bash
npm start
```

## 에이전트 세션 연동

서버가 시작되면 등록된 각 프로젝트의 `.agents/skills`와 `.claude/skills`에 중앙 스킬 symlink를 만든다. 기존 파일이나 다른 대상의 링크는 덮어쓰지 않는다. 관리자로 로그인하면 설치된 공급자 CLI 중 전역 스킬이나 `web-agent-manager` MCP가 빠진 공급자만 상단에 연결 알림이 나타난다. 버튼은 Codex의 `~/.codex/skills` 또는 Claude의 `~/.claude/skills`에 중앙 스킬을 연결하고, 공급자 공식 CLI의 `mcp add` 명령으로 production 브리지 진입점을 사용자 범위 stdio MCP로 등록한다. 공급자 설정 파일 내용이나 인증정보는 읽지 않는다.

스킬은 MCP 도구가 등록돼 있으면 이를 사용하고, 없으면 빌드된 로컬 브리지를 `npm run agent`로 호출하므로 브라우저 쿠키·CSRF·API 키를 다른 프로젝트에 복제하지 않는다.

```bash
npm run agent -- call context.get '{"chatId":160,"limit":80}'
npm run agent -- call delegation.send '{"sourceChatId":160,"targetChatId":163,"prompt":"#160의 남은 작업을 마무리하세요.","idempotencyKey":"160-to-163-finalize"}'
npm run agent -- call delegation.send_wait '{"sourceChatId":160,"provider":"claude","createNew":true,"prompt":"이 구현을 검토하고 결과를 반환하세요.","idempotencyKey":"160-claude-review","timeoutSeconds":300}'
npm run agent -- call delegation.wait '{"delegationId":1,"timeoutSeconds":300}'
```

stdio MCP 서버 진입점은 production build의 `dist/server/scripts/web-agent-manager-agent.js --mcp`다. 제공 도구는 프로젝트·채팅 목록, 세션 문맥 조회, 문맥 스냅샷, 비동기 작업 전달, 새 자식 채팅 생성과 완료 대기, 기존 전달 결과 대기·조회다. 실제 기록 파일이나 DB를 외부 에이전트가 직접 열지 않으며, 순환 위임 방지와 최대 깊이 제한을 적용한다.

웹 채팅의 서브 에이전트 버튼은 같은 위임 계층을 사용한다. 새 작업마다 별도 대상 채팅을 만들며 기존 같은 공급자 채팅을 임의로 재사용하지 않고, 프로젝트 위임 기록과 대상 채팅의 실제 `busy/status`를 3초마다 함께 갱신한다. 대기 도구는 대상 사용자 프롬프트 뒤의 assistant 응답과 실제 idle 상태가 함께 확인돼야 완료 결과를 반환한다. 1,000자 초과 입력이 첨부 안내문으로 바뀌는 경우에도 원본 지시와 별도로 실제 터미널·history에 전달된 문구를 기록해 결과를 정확히 연결한다. 조회·생성·중단·종료·재시작은 관리자 전용 API다.

## systemd 배포

1. 애플리케이션을 `/opt/web-agent-manager`에 배치하고 `web-agent-manager` 전용 Linux 사용자에게 소유권을 부여한다.
2. `/etc/web-agent-manager/web-agent-manager.env`를 root만 읽을 수 있는 권한으로 생성한다.
3. [deploy/web-agent-manager.service](deploy/web-agent-manager.service)를 `/etc/systemd/system/web-agent-manager.service`에 설치한다.
4. 다음 명령으로 서비스를 활성화한다.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now web-agent-manager
sudo systemctl status web-agent-manager
```

`KillMode=process`는 웹 서버 재시작 시 tmux 채팅을 유지하기 위한 설정이다. 호스트 종료 시에는 운영 정책에 따라 tmux 세션도 별도로 정리한다.

## systemd를 쓸 수 없는 환경의 자동 재시작

컨테이너처럼 PID 1이 `init` 프로세스라 `systemctl`이 동작하지 않고 cron·도커 재시작 정책도 쓸 수 없는 환경에서는
[scripts/run-server-supervised.sh](scripts/run-server-supervised.sh)를 tmux 세션 안에서 실행해 자동 재시작을 대신한다.

```bash
tmux new-session -d -s web-agent-manager-server -c /경로/web-agent-manager bash
tmux send-keys -t web-agent-manager-server 'bash scripts/run-server-supervised.sh' Enter
```

이 스크립트는 `npm start`와 같은 프로덕션 명령(`NODE_ENV=production node dist/server/src/server/index.js`)을 실행하고,
프로세스 생존과 `/health` 응답을 함께 감시한다. 프로세스가 종료되면 다시 띄우고, 프로세스는 살아 있는데 헬스가 연속 실패하면
정상 종료를 시도한 뒤 응답이 없을 때 강제 종료하고 재시작한다. 프로세스가 남아 있어도 요청에 응답하지 못하는 상태가
있을 수 있으므로 생존 여부만으로 장애를 판정하지 않는다.

동작은 환경변수로 조정한다. `WAM_RESTART_DELAY`(재시작 간격, 기본 3초), `WAM_HEALTH_INTERVAL`(헬스 확인 주기, 기본 5초),
`WAM_HEALTH_FAIL_LIMIT`(장애 판정 연속 실패 횟수, 기본 3), `WAM_STARTUP_TIMEOUT`(기동 대기 한계, 기본 60초),
`WAM_APP_DIR`(앱 루트, 기본은 스크립트 위치의 상위 폴더), `WAM_NODE_BIN`(Node 실행 파일 절대경로, 기본은 현재 `PATH`의
`node`가 보고하는 실제 `process.execPath`), `WAM_RUN_DIR`(pid·중지 플래그·로그 위치, 기본 `data/supervisor`)를 사용한다.
자동 해석이 불가능한 환경에서만 `WAM_NODE_BIN`에 실제 실행 파일 절대경로를 명시한다.

감시를 멈출 때는 중지 플래그를 만든 뒤 서버를 종료한다. 플래그가 없으면 모든 종료를 장애로 보고 계속 되살린다.

```bash
touch data/supervisor/server.stop
kill "$(cat data/supervisor/server.pid)"
```

컨테이너 자체가 재시작되면 이 루프도 함께 사라진다. 그 경우까지 자동 복구하려면 호스트에서 도커 재시작 정책이나
호스트 systemd로 컨테이너를 관리해야 한다.

## Slack 설정

다음 환경변수 이름만 사용한다.

- `SLACK_BOT_TOKEN`: 일반 알림용 bot token
- `SLACK_USER_TOKEN`: 사용자 명의 기능 확장용이며 일반 알림 fallback으로 사용하지 않음
- `SLACK_CHANNEL_ID`: 알림 대상 채널

값은 웹, DB, 로그에 표시하거나 저장하지 않는다. 미설정 상태에서도 Slack 외 기능은 동작한다.

## 검증

```bash
npm run typecheck
npm test
npm run build
npm run test:resources
npm run test:tui
npm run test:lifecycle
```

`test:resources`는 동일 브라우저 문서에서 주요 탭을 반복 전환하고 Chromium GC 전후의 JS heap·DOM·이벤트 리스너 증가를 검사한다. `test:tui`는 실제 Codex·Claude TUI를 띄워 `/usage`와 `/status`를 직접 입력하고 화면 파싱을 검증한다. `test:lifecycle`은 실제 PTY에 최소 대화를 입력해 새 세션을 저장하고 종료한 뒤 동일 ID resume를 검증하므로 CLI 사용량이 발생할 수 있다.

`npm run test:ui`는 기본적으로 4399 포트의 Vite 서버를 자동 기동하고 API mock 기반 Chrome 시나리오를 실행한 뒤 서버를 정리한다. 실제 로그인까지 포함하려면 별도 테스트 서버와 임시 계정을 준비한 후 다음 환경변수 이름을 설정한다.

```bash
WEB_AGENT_MANAGER_TEST_URL=http://127.0.0.1:4399 \
WEB_AGENT_MANAGER_TEST_USERNAME='테스트 아이디' \
WEB_AGENT_MANAGER_TEST_PASSWORD='테스트 비밀번호' \
npm run test:ui
```

PR CI도 자동 Vite 서버로 동일 Playwright 시나리오를 실행한다. 검증 스크린샷은 `artifacts/ui-chat-terminal.png`, `artifacts/ui-mobile-menu.png`, `artifacts/ui-file-markdown-preview.png`, `artifacts/ui-file-preview-mobile.png`, `artifacts/ui-pr-diff-split.png`, `artifacts/ui-subagent-manager.png`, `artifacts/ui-agent-integration.png`, `artifacts/ui-usage-snapshot.png`, `artifacts/ui-github-repositories.png`, `artifacts/ui-github-project-popup.png`, `artifacts/ui-project-create.png`, `artifacts/ui-cli-auth-popup.png`에 저장된다.

## 보안 경계

- RBAC 1단계 정책은 다음처럼 분류한다.
  - 일반 사용자 허용: 채팅 목록·메시지 조회, 채팅 프롬프트 전송, 승인 응답, 읽기 중심 대시보드
  - 관리자 전용: 프로젝트 등록, 채팅 생성·삭제·시작·중지·중단·모델/모드 변경, 세션 백업·복원·백업 삭제, 지침 파일 쓰기, 파일 업로드·다운로드·압축·텍스트 편집 저장, Git/GitHub 쓰기 작업, 원본 터미널 WebSocket 구독·입력, 프로세스 종료, Slack 설정, 공급자 전역 스킬·MCP 상태 조회와 설치
- 일반 파일 API는 외부망에서 `.git`, `.env*`, `.codex`, `.claude`, 지침 파일과 그 밖의 모든 점 경로를 차단하며, symlink를 해석한 실제 경로에도 같은 규칙을 적용한다. 로그인 응답과 매 파일 요청의 신뢰 네트워크 capability가 true인 내부망 접속에서는 이 제한을 적용하지 않고 민감 경로도 일반 파일과 동일하게 목록·미리보기·다운로드·업로드할 수 있다. 프로젝트 경계와 symlink 실제 경로 검증은 내부망에서도 그대로 적용한다.
- 업로드는 파일당·요청 총량·파일 수·처리 시간·동시 요청·남은 디스크를 제한한다. 중단·제한 초과 시 스트림과 임시 파일을 정리하고, 기본 저장은 hard link 기반 no-replace로 기존 파일을 원자적으로 보존하며 명시한 `overwrite=true`에서만 교체한다.
- `.web-agent-manager-uploads`는 일반 파일 API에서 접근하지 않고 프로젝트와 채팅 소유권을 확인하는 전용 첨부 API만 사용한다. 파일 목록은 symlink를 노출하지 않는다.
- inline 이미지·영상·오디오·PDF 미리보기는 허용 확장자와 매직 바이트가 모두 맞는 경우에만 허용하고 `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`를 보낸다. ZIP·EPUB은 ZIP 시그니처 확인 후 압축파일 안내만 표시하며 콘텐츠를 inline으로 전송하지 않는다. HTML은 스크립트·연결·폼·프레임을 막는 CSP와 무권한 sandbox iframe에서만 렌더링하며 Markdown raw HTML은 실행하지 않는다. 미리보기 헤더의 다운로드 버튼은 현재 채팅 작업공간의 원본 파일을 attachment로 내려받는다.
- 파일 편집 저장은 `previewKind`가 텍스트·Markdown으로 판정한 파일에만 허용하고, 미리보기 한도(256KiB)를 넘겨 내용이 잘린 파일은 뒷부분이 사라지므로 저장을 거부한다.
- ZIP 다운로드 구현은 보존하지만 재귀 민감 경로 필터링을 보강할 때까지 API를 비활성화한다.
- 지침 파일은 명시적 허용 목록과 전용 감사 API로만 편집한다.
- 로그인은 IP+계정명 기준으로 연속 실패를 제한하고 실패·제한 이벤트를 비밀번호 없이 감사 로그에 남긴다.
- 로그인 제한 상태와 인증 실패 감사 로그는 메모리·행 수·보존 기간 상한을 적용하며, 존재하지 않는 계정도 실제 계정과 같은 비밀번호 검증 비용을 사용한다.
- HTTP 응답에는 CSP·프레임·MIME·권한·referrer 제한을 적용하고 HTTPS 공개 주소에는 HSTS를 추가한다. WebSocket은 요청 Origin의 호스트와 프로토콜을 실제 외부 주소와 함께 확인한다.
- 테스트 픽스처와 문서 예시는 실명·개인 이메일 대신 `user@example.com` 같은 더미 식별자를 사용한다.
- 모든 Git/gh 실행은 셸 문자열이 아닌 고정 명령과 인자 배열을 사용한다.
- 브랜치 이름은 제한된 문자 형식으로 검증하고 worktree 연결은 `git worktree list --porcelain`에 실제 등록된 경로만 허용한다. 실행 중 채팅과 미커밋 작업공간은 전환·제거하지 않으며 앱이 만든 worktree만 자동 제거하고 외부 worktree는 연결 정보만 해제한다.
- 웹 입력은 CLI 명령 인자가 아니라 실행 중 tmux pane에 bracketed paste와 실제 Enter 키 이벤트로 전달한다. 유휴 Codex 일반 메시지는 작업중 또는 빈 입력창으로 바뀌었는지 확인하고, 초안이 남으면 Enter를 한 번만 재시도한 뒤 실패 시 입력·busy 상태를 복구한다.
- 공급자 인증 저장소, 환경 파일, 쉘 히스토리, 토큰 값을 읽거나 웹에 노출하지 않는다.
- 에이전트 연동 소켓은 데이터 디렉터리에 `0600`으로 만들고 브라우저 세션 토큰을 사용하지 않는다. 메시지 전달은 명시적 도구와 멱등 키를 사용하며 자기 채팅·조상 채팅 재호출과 4단계 초과를 차단하고 감사 로그에 대상 채팅을 기록한다.
- 공급자 자동 감지는 PATH의 실행 파일과 공식 `mcp get` 명령만 사용한다. 연동 버튼을 누르기 전에는 공급자 설정을 변경하지 않으며, 설치 시에도 기존 사용자 스킬 파일은 덮어쓰지 않는다.
- Pull Request와 `main` 변경은 GitHub Actions에서 전체 의존성 감사, 타입 검사, 단위 테스트와 프로덕션 빌드를 수행한다. 외부 Action은 검증한 커밋 SHA로 고정한다.

## 호환성 주의

Claude 기록 JSONL과 Codex TUI 승인 화면은 공급자 내부 형식 변경의 영향을 받을 수 있다. 현재 어댑터와 회귀 검증 기준은 위 기준 버전이다. 사용량 파싱 실패 시 0으로 대체하지 않고 마지막 정상 값과 stale/unavailable 상태를 유지한다.
