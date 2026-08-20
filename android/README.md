# Android WebView 앱

기존 web-agent-manager 서버에 연결하는 Android 6(API 23) 이상 클라이언트다. 앱 자체에 서버 데이터나 로그인 비밀번호를 넣지 않고 WebView 쿠키와 서버 권한을 그대로 사용한다.

## 기본 APK 빌드

JDK 17과 Android SDK Platform 36·Build Tools 36.0.0을 준비한다.

```bash
cd android
./gradlew assembleDebug lintDebug
```

설치 가능한 개발 APK는 `app/build/outputs/apk/debug/app-debug.apk`에 생성된다. `assembleRelease`의 기본 결과는 서명되지 않으므로 실제 배포 전에는 Android Studio/CI의 별도 release 서명 설정을 사용한다. JKS·keystore·비밀번호는 저장소에 넣지 않는다.

첫 실행에서 서버 주소를 입력한다. 공개 또는 VPN 경유 접속은 유효한 HTTPS 인증서를 권장한다. HTTP는 사설 IPv4·CGNAT(Tailscale)·로컬 DNS·IPv6 ULA/link-local 주소만 앱이 허용하며, 인증서 오류를 우회하지 않는다.

앱은 상태바·디스플레이 컷아웃·하단 내비게이션바·화면 키보드의 기기별 실제 영역만큼 WebView를 줄인다. 웹 헤더와 채팅 입력창이 시스템 UI에 가려지지 않으며, 제스처 내비게이션과 3버튼 내비게이션 전환에도 새 inset을 다시 적용한다.

동일 서버의 첨부·파일 다운로드는 현재 WebView 로그인 쿠키를 Android `DownloadManager`에 전달하고 시스템 공용 `Downloads` 폴더에 저장한다. 완료 파일은 `내 파일 > 다운로드`에서 확인할 수 있다. Android 10 이상은 별도 저장소 권한이 필요 없고 Android 9 이하는 최초 다운로드 때 공용 폴더 저장 권한을 요청한다.

채팅 첨부 버튼으로 파일 선택기(갤러리·문서 앱 등)를 여는 동안 시스템이 메모리 회수로 앱 프로세스를 재시작하면 진행 중이던 선택은 복구할 수 없다 — 이 경우 "파일 선택이 처리되지 못했습니다(앱이 재시작됨)" 토스트가 뜨니 다시 시도한다. 앱은 이런 재시작 후에도 로그인 화면이 아니라 원래 보던 채팅 화면으로 돌아간다.

## 설정 버튼

설정 톱니를 드래그하면 가장 가까운 좌우 화면 가장자리에 붙고 세로 위치가 저장된다. 톱니를 길게 누르거나 설정 대화상자의 `설정 버튼 숨기기`를 누르면 작은 가장자리 탭으로 접히며, 그 탭을 누르면 다시 복원된다. 화면 회전·시스템 바·키보드 높이가 바뀌면 저장 위치를 새 안전 영역 안으로 자동 보정한다.

## 앱 기기 인증

외부망에서도 숨김 파일 열람과 삭제·프로세스 종료 등 기존 내부망 전용 기능을 사용하려면 다음 순서로 최초 1회 기기를 등록한다.

1. Android 앱과 이 기능이 포함된 web-agent-manager 서버를 함께 사용한다.
2. 내부망 또는 VPN 사설 주소에서 앱으로 서버에 접속해 관리자 계정으로 로그인한다.
3. 설정 톱니를 누르고 `이 기기 앱 인증`을 선택한다.
4. 이후 설정에서 유효한 HTTPS 외부 주소로 바꾸면 앱이 기기 서명으로 새 로그인 세션을 만들고 화면을 한 번 새로고침한다. 아이디·비밀번호를 다시 입력할 필요가 없다.

앱은 설치 단위 P-256 개인키를 Android Keystore에 내보내기 불가 상태로 생성한다. 서버에는 공개키와 불투명 기기 식별자만 저장한다. 새 외부 origin에는 공개키·기기 ID가 일치할 때만 2분짜리 로그인 challenge를 주고, challenge와 앱이 실제 설정한 origin을 함께 ECDSA 서명해 다른 서버의 challenge 중계를 차단한다. 검증 후에는 해당 관리자와 기기에 연결된 만료 가능 HttpOnly 웹 세션을 발급하며 내부망 로그인 쿠키나 비밀번호를 주소 사이에 복사하지 않는다. 실제 내부망 여부와 앱 인증 신뢰는 별도로 기록하므로 인증된 외부 세션이 새 기기를 연쇄 등록할 수 없고, 기존 관리자 권한·CSRF 검증도 그대로 적용된다. 명시적 로그아웃은 유지하며, 자동 연결이 실패했을 때 설정의 `연결`을 다시 누르면 현재 주소에서 한 번 재시도한다.

기기를 잃어버리거나 더 이상 사용하지 않으면 설정의 `이 기기 인증 해제`를 누른다. 현재 서버의 기기 등록이 비활성화되고 그 기기로 인증된 모든 웹 세션의 내부망 capability가 즉시 회수된다. Keystore 키는 다른 등록 서버에서도 같은 기기임을 증명할 수 있도록 앱 안에 유지되지만, 해제한 서버에서는 비활성 공개키라 다시 사용할 수 없다.

## FCM 활성화

기본 APK는 Firebase 인증 파일 없이 빌드되며 WebView와 위젯은 정상 동작하지만 FCM 등록은 비활성이다. 나중에 다음 두 쪽을 설정하면 기존 서버 알림이 앱 푸시로도 전송된다.

1. Firebase Console에서 Android 앱 패키지 `com.webagentmanager.android`를 등록하고 Cloud Messaging API를 활성화한다.
2. 내려받은 `google-services.json`을 로컬의 `android/app/google-services.json`에 둔다. 이 파일은 `.gitignore` 대상이다.
3. APK를 다시 빌드·설치하고 앱에서 로그인한 뒤 Android 알림 권한을 허용한다.
4. 서버 실행 환경에서 다음 변수 이름을 설정하고 재시작한다. 값이나 서비스 계정 파일은 저장소에 넣지 않는다.

```dotenv
WEB_AGENT_MANAGER_FCM_ENABLED=1
WEB_AGENT_MANAGER_FCM_PROJECT_ID=Firebase 프로젝트 ID
GOOGLE_APPLICATION_CREDENTIALS=/보안/경로/service-account.json
```

`WEB_AGENT_MANAGER_FCM_PROJECT_ID`는 기본 자격증명의 프로젝트와 전송 대상 프로젝트가 같으면 생략할 수 있다. 서비스 계정에는 대상 프로젝트의 Firebase Cloud Messaging API 전송 권한만 최소 범위로 부여한다. 서버는 Google 기본 자격증명으로 FCM HTTP v1을 호출하며 토큰을 API 응답이나 로그에 다시 노출하지 않고, Firebase가 폐기했다고 응답한 기기는 자동 비활성화한다.

관리자로 로그인한 앱은 페이지 로드 때 토큰 등록을 재시도한다. 서버의 `POST /api/mobile/push/test`는 CSRF가 필요한 관리자 전용 테스트 경로이며 일반 브라우저/앱 UI에는 별도 비밀 값을 노출하지 않는다.

## 위젯

홈 화면 위젯은 WebView와 같은 로그인 쿠키로 `GET /api/mobile/widget`을 호출한다. 먼저 앱을 열어 로그인해야 한다. 런처 크기에 따라 1×1 StackView(Claude/Codex 스와이프), 2×1 좌우 사용량, 1×2 상하 사용량, 2×2 두 모델+CPU+RAM으로 전환한다.

Android 위젯의 시스템 주기 제한에 맞춰 30분마다 갱신하며, 위젯의 `↻` 또는 앱 페이지 로드 때 즉시 새로고침한다. 서버가 닿지 않으면 마지막 정상 값은 유지하고 짧은 오류 상태만 표시한다.

## 외부 접속 보안

기기 최초 등록은 실제 내부망 또는 `WEB_AGENT_MANAGER_TRUSTED_NETWORKS`에 등록된 VPN CIDR에서만 가능하다. 앱 인증을 쓰지 않는 브라우저 요청은 계속 실제 요청 주소로 판정하며, 공개 인터넷 대역 전체를 신뢰 목록에 넣지 않는다. 외부 앱 접속은 개인키 서명과 로그인 쿠키가 노출되지 않도록 유효한 HTTPS reverse proxy를 사용한다.
