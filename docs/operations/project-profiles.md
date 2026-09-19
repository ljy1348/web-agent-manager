# 프로젝트 프로필 운영 계약

작성일: 2026-09-12

최근 검증: 2026-09-13

프로젝트 프로필은 기존 `agent_presets`와 불변 `agent_preset_versions`를 재사용한다. 실험에서 승격한 preset과 일반 채팅 profile이 같은 version pinning 규칙을 사용하므로, 활성 기본값이 바뀌어도 이미 만든 채팅의 `preset_version_id`와 `preset_config_json`은 바뀌지 않는다.

## 작업 종류

- `analysis`: 기본 `read-only`
- `implementation`: 기본 `workspace-write`
- `high_risk`: `workspace-write`와 `on-request`
- `operations`: `workspace-write`와 `on-request`

한 프로젝트에는 task kind별 활성 프로필이 하나만 존재한다. 다른 프로필을 활성화하면 이전 활성 프로필은 draft로 돌아가지만 기존 채팅의 snapshot은 유지된다.

## API

```text
GET  /api/projects/:projectId/profiles
GET  /api/admin/project-profiles/readiness
POST /api/projects/:projectId/profile-draft
POST /api/projects/:projectId/profiles
POST /api/projects/:projectId/profiles/:profileId/versions
POST /api/projects/:projectId/profiles/:profileId/activate
```

모든 API는 관리자 전용이다. 설정의 `프로젝트 Agent profile` 카드는 `profile-draft`에 `provider`와 `taskKind`를 보내 `AGENTS.md`, `CLAUDE.md`, `package.json` scripts를 검사하지만 저장하지 않는다. Claude를 고르면 `CLAUDE.md`가 단독 존재하면서 정확한 `@AGENTS.md` import가 없는 경우도 경고한다. 사용자가 반환된 JSON과 `AGENTS.md 없음`·import 불일치·검증 명령 없음·보호 정책 없음 경고를 검토한 뒤에만 version 1이 draft로 저장된다. 추가 version도 기존 version을 덮어쓰거나 자동 활성화하지 않는다. 활성화는 프로젝트·task kind·profile·version과 경고를 보여주는 별도 확인 뒤 검토한 `versionId`를 명시한다. profile 저장·version 추가·활성화에는 관리자 권한, 최근 재인증, 신뢰 네트워크가 모두 필요하며 test_only 계정은 실행할 수 없다.

카드 상단의 전체 준비 상태는 활성 프로젝트마다 `analysis`와 `implementation`의 active version, verification step, protected action, 현재 AGENTS/CLAUDE/import와 package script 탐지 경고를 batch로 다시 계산한다. 응답에는 프로젝트 경로, 지침 본문, package command 원문을 넣지 않는다. 프로젝트 행을 누르면 개별 검토 대상으로 선택될 뿐 자동 profile 생성이나 활성화는 일어나지 않는다.

전용 worktree 채팅은 생성 직후 선택된 immutable profile version/snapshot과 프로젝트 원본·worktree의 로컬 지침 SHA-256을 함께 검사한다. profile이 없거나 요구 지침이 빠졌거나 원본과 내용이 다르거나 Claude의 `@AGENTS.md` import가 사라지면 채팅을 삭제하거나 임의 수정하지 않고 `needs_review` 증거를 저장해 채팅 상단에 표시한다. 모두 일치하면 `valid`로 표시한다. 이 증거는 생성 시점 검증이며 이후 사용자가 파일을 고쳤다는 보장은 아니므로, 완료 시에는 별도 verification gate의 commit/diff snapshot을 사용한다.

새 채팅 생성에서 `presetId`나 `presetVersionId` 대신 `taskKind`를 보내면 해당 프로젝트/task kind의 활성 version을 자동 pin한다. 공급자가 다른 프로필과 다른 프로젝트의 version은 거부한다. worktree 채팅에도 같은 pinning 규칙을 적용한다.

## 등록 프로젝트 맞춤 초안

등록 이름이 정확히 일치하는 현재 8개 프로젝트에는 로드맵 9장의 추천 catalog를 적용한다. `WSS-Server`는 Gradle test·조건부 API 문서 계약, `WSS-admin-web`는 test/build·frontend 사람 검토, `myagent`는 verify·조건부 Playwright, `geulmeok-frontend`는 build·사람 검토, `geulmeok-scrap`은 fixture 우선 사람 검토, `resume`은 중첩 job-automation test·근거 검토, `스터디`는 single-agent 사람 검토, `genshincalculator`는 test·typecheck를 제안한다. 각 초안은 `profileTemplate.id`와 `source=registered_project_catalog`를 불변 snapshot에 보존한다.

실제 wrapper나 package script가 있을 때만 `argv`를 제안하며 없으면 명령을 추측하지 않고 경고한다. 맞춤 대상이 아니면 현재 `package.json`의 `typecheck`, `lint`, `test`, `build`만 일반 초안으로 제안한다. 초안 생성은 어떤 명령도 실행하지 않으며, 저장·활성화 뒤 task verification gate가 별도로 실행한다.

## 실행 강제 경계

저장, 새 version, 활성화, 실험 run 승격, 채팅 시작에서 같은 profile parser를 다시 적용한다. `analysis`는 반드시 `read-only`이고, `danger-full-access`는 `high_risk` 또는 `operations`에서만 가능하며 `approvalMode=never`와 결합할 수 없다. 추가 쓰기 경로는 실제 디렉터리·중복 없는 최대 10개·`workspace-write`와 `on-request` 조합만 허용한다. 새 채팅의 감사 로그에는 pin한 `profileVersionId`를 남긴다.

Codex TUI는 현재 설치 CLI의 `--sandbox`, `--ask-for-approval`, `--model`, reasoning config와 `--add-dir`로 적용한다. Claude와 Grok은 각 CLI가 제공하는 제한·permission·model·tool 옵션으로 보수적으로 매핑하며 안전한 대응 옵션이 없는 요청은 세션 생성 전에 거부한다. Codex app-server 경로가 지원하지 못하는 추가 쓰기 경로·tool filter·reasoning 옵션은 전송 전에 TUI로 폴백한다. `protectedActions`는 검토·verification 정책의 선언 목록이며 임의 명령 문자열을 의미적으로 해석하는 차단기가 아니므로, 실제 차단은 native sandbox와 approval 경계를 기준으로 한다.

프로필이 없는 기존 채팅의 실행 방식은 호환성을 위해 그대로 유지한다. 예전 Agent Lab snapshot에 `taskKind`가 없으면 `implementation`으로 해석하지만, 현재 안전 경계를 넘으면 새 version으로 수정하기 전에는 활성화·실행되지 않는다.
