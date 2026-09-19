# 전체 암호화 백업·복구

작성일: 2026-09-12

## 범위와 안전 경계

전체 백업은 SQLite의 온라인 snapshot과 WAM이 생성한 key를 하나의 `.wambackup` 파일로 묶는다. 프로젝트, 프로필과 버전, 일정, 채팅의 공급자 session mapping, task와 verification 원장이 같은 DB 시점으로 보존된다. 실행 중 tmux 프로세스와 공급자 로그인 디렉터리, 프로젝트 작업 파일은 포함하지 않는다.

- AES-256-GCM 본문과 scrypt(`N=32768`, `r=8`, `p=1`) 파생 key를 사용한다.
- passphrase는 요청 처리 중에만 사용하며 DB, manifest, 감사 로그와 응답에 저장하지 않는다. 잃어버리면 복구할 수 없다.
- 백업 디렉터리는 `0700`, package와 포함 key는 `0600`이어야 한다. symlink와 다른 사용자에게 열린 key는 거부한다.
- manifest에는 경로, 크기, mode, SHA-256, DB 건수와 외부 요구사항만 있고 DB와 key byte는 암호문 안에 있다.
- 기존 dataDir를 덮어쓰지 않는다. 복구 대상은 존재하지 않거나 완전히 빈 일반 디렉터리여야 한다.
- 복구 뒤 기존 web session, MFA/mobile challenge, 일회용 로그인 코드와 vault lease는 폐기한다. 채팅 session ID·profile/task mapping은 보존하되 tmux가 없으므로 채팅은 `stopped`, `busy=0`으로 시작한다.

공급자별 `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME`과 프로젝트 저장소는 별도로 백업해야 한다. `WEB_AGENT_MANAGER_ONE_TIME_CODE_SECRET`을 환경변수로 운영한 경우 package가 그 원문을 담지 않고 manifest의 `externalRequirements`에만 표시하므로 새 호스트에도 별도로 공급한다.

## 생성과 다운로드

관리자로 로그인하고 설정의 `로그인 보안` 카드에서 본인 확인을 갱신한다. 신뢰 네트워크에서 `전체 암호화 백업`의 서로 같은 16자 이상 passphrase 두 칸을 입력해 생성한 다음 즉시 다운로드한다. 생성·다운로드·삭제는 관리자 전용이고 최근 재인증이 필요하며, 생성·다운로드·삭제의 파일 작업은 신뢰 네트워크에서만 허용한다. `test_only` 계정은 접근할 수 없다.

package와 passphrase는 서로 다른 보관소에 둔다. 백업 파일을 다운로드한 뒤 서버 사본을 삭제해도 다운로드 사본은 영향받지 않는다.

schema migration 전 구버전 서버에 위 UI/API가 아직 없으면 새 production build의 offline 생성 CLI를 사용한다. 이 CLI는 `openDatabase`를 호출하지 않고 현재 SQLite를 `readonly`·`fileMustExist`로 열어 migration하지 않는다. package를 만든 직후 OS 임시 디렉터리의 빈 환경으로 실제 복호화·integrity/key 검증을 완료하며, 검증이 실패하면 이번 호출에서 만든 package만 제거한다.

```bash
export WEB_AGENT_MANAGER_BACKUP_PASSPHRASE_FILE='/secure/outside-workspace/wam-backup-passphrase'
npm run backup:create
unset WEB_AGENT_MANAGER_BACKUP_PASSPHRASE_FILE
```

passphrase 파일은 absolute path의 symlink가 아닌 현재 실행 사용자 소유 0600 일반 파일이어야 한다. 마지막 개행 하나 외의 줄바꿈과 NUL은 거부한다. 직접 값인 `WEB_AGENT_MANAGER_BACKUP_PASSPHRASE`도 하위 호환으로 지원하지만 두 변수를 동시에 설정하면 실패한다. 출력의 `verifiedRestorable=true`, backup ID, 건수, `data/full-backups/*.wambackup` 경로를 확인하고 package와 passphrase를 서로 다른 보관소로 복제한 뒤에만 migration/restart를 승인한다. pre-migration schema에 MFA·vault·challenge 같은 최신 추가형 테이블이 없어도 복구 검증은 존재하는 테이블만 안전하게 정리한다.

## 빈 환경 실제 복구

1. 새 호스트에서 WAM 서버를 중지한다.
2. 복구할 버전의 코드를 설치하고 production build를 준비한다.
3. 기존 파일이 전혀 없는 새 dataDir 경로를 정한다. 현재 운영 dataDir를 대상으로 지정하지 않는다.
4. passphrase를 shell history의 명령 인자에 넣지 않고 환경변수로 전달한다.

```bash
export WEB_AGENT_MANAGER_BACKUP_PASSPHRASE_FILE='/secure/outside-workspace/wam-backup-passphrase'
npm run backup:restore -- --backup /secure/path/backup.wambackup --data-dir /new/empty/wam-data
unset WEB_AGENT_MANAGER_BACKUP_PASSPHRASE_FILE
```

복구 명령은 magic/version, manifest 제한, 전체 길이, ciphertext SHA-256, GCM tag, 항목별 SHA-256, SQLite `integrity_check`, vault/MFA key 존재를 모두 확인한 뒤 sibling staging 디렉터리를 원자 rename한다. 하나라도 실패하면 대상에 부분 복구 파일을 남기지 않는다. 성공 시 `restore-manifest.json`에 백업 ID와 source package SHA-256이 남는다.

5. 출력의 프로젝트·채팅·프로필·일정·task·verification 건수가 예상과 맞는지 확인한다.
6. 새 dataDir를 서버 설정에 연결해 기동하고 새로 로그인한다. 복구 전 cookie가 작동하지 않는 것이 정상이다.
7. 채팅을 재개하기 전에 프로젝트 경로와 별도 복원한 저장소·공급자 로그인 디렉터리를 확인한다.

## 정기 복구 훈련

운영 복구 전에 package 자체를 검사하려면 build된 버전에서 다음 명령을 실행한다. 이 명령은 OS 임시 디렉터리 아래 새 환경으로 실제 복호화·복구하고, manifest 건수와 DB 건수 및 vault/MFA key 개방 가능성을 확인한 뒤 임시 환경을 삭제한다. 운영 dataDir는 읽거나 덮어쓰지 않는다.

```bash
export WEB_AGENT_MANAGER_BACKUP_PASSPHRASE_FILE='/secure/outside-workspace/wam-backup-passphrase'
npm run backup:drill -- --backup /secure/path/backup.wambackup
unset WEB_AGENT_MANAGER_BACKUP_PASSPHRASE_FILE
```

최소 월 1회와 WAM/SQLite schema 변경 뒤에 최근 외부 보관 사본으로 훈련하고, 종료 코드·백업 ID·건수·소요 시간만 운영 기록에 남긴다. passphrase나 복구 파일 내용은 로그에 남기지 않는다. 자동 테스트도 임시 실제 SQLite와 별도 CLI 프로세스로 이 훈련을 매 회귀 검증하며, 5,000개 채팅 snapshot·암호화·복구의 회귀 상한은 5초다.
