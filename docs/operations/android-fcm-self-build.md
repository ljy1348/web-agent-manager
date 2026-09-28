# 개인 Firebase 프로젝트로 Android 앱 빌드하기

푸시 릴레이나 공용 Firebase 계정은 사용하지 않는다. 푸시가 필요한 사용자가 자신의 Firebase 프로젝트로 Android 앱을 한 번 빌드하고, 앱이 접속할 **중앙 WAM** 서버에 같은 프로젝트의 발송 자격증명을 설정한다. 여러 WAM을 연결하는 경우 원격 서버에는 Firebase 설정이 필요 없으며, 중앙이 원격 알림을 집계한다. Firebase 없이 빌드한 앱은 웹 화면과 위젯은 동작하지만 푸시는 받지 않는다.

## 1. Android 앱 등록·빌드

1. Firebase 프로젝트를 만들고 Android 앱의 패키지 이름으로 `com.webagentmanager.android`를 등록한다. Firebase 콘솔에서 받은 `google-services.json`을 이 저장소의 `android/app/google-services.json`에 둔다. 이 파일은 서비스 계정 개인키가 아니지만 개인 프로젝트 식별 정보이므로 저장소에 커밋하지 않는다.
2. JDK 17과 Android SDK Platform 36·Build Tools 36.0.0을 준비하고 `cd android && ./gradlew assembleDebug lintDebug`를 실행한다. 개인 시험용 APK는 `android/app/build/outputs/apk/debug/app-debug.apk`에 생성된다.
3. 계속 업데이트해 설치할 release APK는 본인이 보관하는 일정한 Android 서명 키로 서명한다. 기본 `assembleRelease` 산출물은 서명되지 않는다. 키·비밀번호는 APK나 저장소에 넣지 않는다.

## 2. 중앙 WAM 서버 설정

FCM HTTP v1 API를 활성화하고, 프로젝트 ID와 서버 전용 서비스 계정 자격증명을 중앙 WAM 실행 환경에만 둔다. 서비스 계정 JSON을 Android 앱에 넣거나 다른 사용자에게 공유하지 않는다.

```dotenv
WEB_AGENT_MANAGER_FCM_ENABLED=1
WEB_AGENT_MANAGER_FCM_PROJECT_ID=내_Firebase_프로젝트_ID
GOOGLE_APPLICATION_CREDENTIALS=/서버_전용_보안_경로/service-account.json
```

설정 후 중앙 WAM을 재시작한다. 중앙과 원격 WAM을 연결했다면 중앙은 원격의 이벤트 ID·유형만 읽고 채팅 본문은 가져오지 않는다. 직접 FCM에 보내는 로컬 알림은 기존 이벤트 본문을 사용하며, 원격 이벤트는 `연결된 컴퓨터에 새 알림이 있습니다.`라는 일반 문구로 보낸다. 원격 연결 전의 과거 이벤트는 재생하지 않는다.

tmux 감시 스크립트로 운영하는 설치에서는 위 세 환경변수를 `data/secrets/fcm.env`에 두어도 된다. 파일은 실행 계정 소유의 일반 파일로 만들고 권한을 `0600`으로 제한한다. 서버는 시작할 때 이 파일을 읽으며, 실행 환경에 이미 지정된 값이 있으면 그 값을 우선한다. 서비스 계정 JSON은 별도 `0600` 파일로 보관하고 이 환경 파일에는 절대경로만 적는다. 두 파일 모두 Git에 커밋하지 않는다.

## 3. 실제 수신 확인

직접 빌드한 앱에서 중앙 WAM에 관리자로 로그인하고 Android 알림 권한을 허용한다. 설정의 **Android 앱 푸시**에서 활성 상태·프로젝트 ID·등록 기기 수를 확인한 뒤 **테스트 알림**을 누른다. `GET /api/mobile/push`도 같은 상태를 제공한다. 서버에서 요청을 보냈다는 표시만으로 단말 표시까지 증명되지는 않으므로 휴대폰에서 실제 수신을 확인한다. 앱에서 다른 WAM 주소로 전환하면 이전 서버의 기기 등록 해제를 시도하며, 이전 서버에 닿지 않으면 다음 접속 때 재시도한다.

앱의 `google-services.json` 프로젝트와 중앙 WAM의 `WEB_AGENT_MANAGER_FCM_PROJECT_ID`가 다르면 직접 발송이 작동하지 않는다. 개인 앱을 다시 빌드할 때도 같은 서명 키를 유지해야 기존 앱을 업데이트할 수 있다.
