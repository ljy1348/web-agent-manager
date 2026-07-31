web-agent-manager v0.2.0 설치
====================

Linux
1. Node.js 22 이상과 tmux를 설치합니다.
2. 터미널에서 ./setup.sh 하나만 실행합니다.
3. 안내에 따라 관리자 계정을 입력하면 설치 후 서버가 바로 시작됩니다.

macOS
1. Node.js 22 이상과 tmux를 설치합니다. Homebrew 사용 시 brew install tmux
2. setup.command를 실행합니다.
3. macOS가 실행을 차단하면 파일을 우클릭한 뒤 열기를 선택합니다.

Windows
web-agent-manager는 tmux와 Unix socket이 필요하므로 WSL2에서 실행합니다.
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

Windows Electron 앱은 tmux와 Unix socket 제약 때문에 WSL2에서 setup-windows.cmd로
실행한 서버에 연결하는 데스크톱 창입니다. 다른 주소의 서버를 열려면
WEB_AGENT_MANAGER_SERVER_URL 환경변수를 설정할 수 있습니다.
