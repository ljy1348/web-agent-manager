web-agent-manager 설치
====================

Linux
1. Node.js 22 이상과 tmux를 설치합니다.
2. 터미널에서 ./setup.sh 하나만 실행합니다.
3. 안내에 따라 관리자 계정을 입력하면 설치 후 서버가 바로 시작됩니다.

macOS
1. Node.js 22 이상과 tmux를 설치합니다. Homebrew 사용 시 brew install tmux
2. setup.command를 실행합니다.
3. macOS가 실행을 차단하면 파일을 우클릭한 뒤 열기를 선택합니다.

Windows 데스크톱 앱 (권장, 터미널 불필요)
데스크톱 설치 파일(web-agent-manager Setup *.exe)을 실행해 설치한 뒤, 첫 화면에서
"이 PC에서 WAM 실행"을 고르면 Node.js 설치 없이 서버가 앱 안에서 돕니다.
포트와 다른 컴퓨터 접속 허용을 고르고 관리자 계정을 만들면 끝입니다. 창을 닫으면 트레이에 남습니다.

Windows 네이티브 노드 (WSL 없이, 그 PC의 Claude 앱·Codex 앱 대화 관리)
1. setup-windows-native.cmd를 실행합니다. Node.js 22가 없으면 winget 설치를 제안합니다.
2. 포트와 접속 범위(이 PC만 / 사설망·Tailscale)를 고르고, 관리자 계정을 만듭니다.
3. 로그온 자동 시작을 고를 수 있고, 설치가 끝나면 서버가 바로 시작됩니다.
4. 이후에는 run-windows-native.cmd로 실행합니다. 설정을 바꾸려면
   setup-windows-native.cmd -Reconfigure 를 실행합니다.
5. 메인 WAM에 붙이려면 이 PC의 WAM에서 설정 → 운영 → 컴퓨터 연결 → 연결 토큰을 만든 뒤,
   메인 WAM의 같은 화면에서 이 PC 주소와 토큰을 등록합니다.
- 무인 설치: WEB_AGENT_MANAGER_ADMIN_USERNAME, WEB_AGENT_MANAGER_ADMIN_PASSWORD 환경변수를
  미리 두면 관리자 입력을 묻지 않습니다.
- 현재는 기존 대화 보기까지 지원합니다. 이 PC에서 대화를 이어서 작업하는 기능은 준비 중입니다.

Windows (WSL2)
tmux 기반 전체 기능을 쓰려면 WSL2에서 실행합니다.
1. 관리자 PowerShell에서 wsl --install 을 실행하고 Ubuntu 초기 설정을 마칩니다.
2. WSL Ubuntu에 Node.js 22 이상과 tmux를 설치합니다.
3. setup-windows.cmd를 실행합니다.
4. 안내에 따라 관리자 계정을 입력하면 설치 후 서버가 바로 시작됩니다.

개별 설치·관리자 생성·실행이 필요하면 기존 install, create-admin, run 스크립트를
각각 사용할 수 있습니다.

에이전트 연동
=============

관리자로 로그인하면 설치된 Codex·Claude CLI를 web-agent-manager가 감지합니다.
상단의 "Codex 연결" 또는 "Claude 연결" 버튼은 다음 작업을 함께 수행합니다.
- web-agent-manager 세션 조회·작업 전달 스킬을 사용자 전역 스킬 경로에 연결
- 로컬 Unix socket을 사용하는 web-agent-manager stdio MCP 등록
- 새 Claude·Codex 자식 채팅 생성, 완료 대기와 결과 회수 도구 등록

Codex·Claude를 나중에 설치해도 web-agent-manager 화면 복귀 시와 60초마다 다시 감지합니다.
기존 스킬 파일은 덮어쓰지 않으며 CLI 인증정보나 설정 파일 내용은 읽지 않습니다.

Electron 데스크톱
=================

Linux와 macOS 설치 파일은 production 서버와 웹 UI를 함께 포함합니다.
시스템에 Node.js 22 이상과 tmux가 있어야 하며, 첫 실행 화면에서 관리자 계정을
만들면 설치된 Claude·Codex 스킬과 MCP도 자동으로 확인합니다.

Windows Electron 앱은 서버를 포함하지 않고 다른 WAM에 접속하는 창입니다. 처음 실행하면
서버 주소를 입력하고(WSL2 서버, Windows 네이티브 노드, 다른 컴퓨터의 WAM 모두 가능),
메뉴의 연결 → 연결 서버 변경으로 바꿀 수 있습니다.
