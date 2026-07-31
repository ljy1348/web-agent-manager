# 변경 기록

## 0.2.0 - 2026-07-31

### 주요 기능

- Claude Code와 Codex 채팅, 실제 TUI 터미널, 사용량·상태·승인 요청을 한 웹 화면에서 관리한다.
- 파일 탐색·형식별 미리보기, GitHub 저장소 프로젝트 생성, 대용량 diff 지연 렌더링과 통합·분할 보기를 제공한다.
- 다른 채팅 문맥 조회, Claude·Codex 상호 작업 위임과 서브 에이전트 관리를 MCP·스킬로 연결한다.
- Linux·macOS·Windows WSL2 압축 설치, Electron 패키지와 다중 아키텍처 Docker 이미지를 제공한다.

### 보안·운영

- 로그인 계정·IP 제한에 메모리 상한과 만료 정리를 적용하고 인증 실패 감사 로그 보존량을 제한했다.
- 미등록 계정 로그인도 동일한 scrypt 검증 비용을 사용하도록 해 계정 존재 여부의 시간 차이를 줄였다.
- WebSocket Origin의 호스트·프로토콜 검증, HTTP 보안 헤더와 Slack·ntfy 테스트 전송의 관리자 권한을 추가했다.
- 운영 기본 로그를 `info`로 낮추고 채팅 상태 원문 추적은 `debug`에서만 기록한다.
- 개발 호스트를 환경변수로 분리하고 공개 화면·문서·테스트에서 운영 식별자를 제거했다.
- PR 검증 CI, Dependabot, 고정 GitHub Action SHA, Docker provenance·SBOM, 릴리즈 CycloneDX SBOM·SHA-256 체크섬을 추가했다.
- 운영·개발 의존성 감사 결과를 0건으로 정리하고 Docker의 Codex·Claude CLI 버전을 고정했다.
