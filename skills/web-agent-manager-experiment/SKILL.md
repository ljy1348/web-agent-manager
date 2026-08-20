---
name: web-agent-manager-experiment
description: web-agent-manager 실험실에서 구성(스킬셋·하네스·모델)을 비교 실행하고 "어떤 상황에 무엇이 나은지" 권고를 회수한다. 사용자가 스킬·하네스·모델 중 무엇이 나은지 묻거나, 여러 조건을 돌려 비교해 달라고 하거나, 실험 결과를 확인해 달라고 하면 사용한다.
---

# web-agent-manager 실험실

실험실은 같은 작업을 여러 실행 조건으로 반복하고 완성도·토큰·시간을 비교해 **조건부 권고**를 만든다.
표를 눈으로 해석하지 말고 아래 순서로 권고를 회수한다.

## 1. 대상 확인

1. `web_agent_manager_experiment_list`로 프로젝트의 실험과 Variant를 본다.
2. 외부 공개 저장소를 대상으로 하는 실험이면 `web_agent_manager_experiment_fixtures`로 fixture 상태를 본다.
   `status`가 `ready`가 아닌 fixture는 적격성 게이트를 통과하지 못한 것이라 실행할 수 없다.

## 2. 비교 실행

반복 실행은 개별 run을 하나씩 시작하지 말고 **실행 계획**으로 건다.
계획은 `Variant × 반복`을 arm 회전 교차 순서(A B C / B C A / C A B)로 펼쳐 순서 효과를 없앤다.

```
web_agent_manager_experiment_plan_start { experimentId, stage, repetitions }
```

- `stage`는 `screening`(후보 걸러내기) → `grid`(축 넓히기) → `confirmation`(확증) 순서로 쓴다.
- `repetitions`는 확증을 목표로 하면 **최소 4회**다. 3회는 3승 0패 대 0승 3패여도 95% 신뢰구간이
  겹쳐 확증 등급이 나올 수 없다.
- 계획이 끝나면 격리 작업공간과 스킬 bundle이 **자동으로 정리된다**. 블라인드 평가를 붙일 계획만
  `cleanup: false`로 시작해 worktree를 남기고, 평가가 끝난 뒤 `web_agent_manager_experiment_cleanup`을 부른다.
- 실행은 측정 오염을 막기 위해 전역에서 한 번에 하나씩만 돈다. `web_agent_manager_experiment_plans`로
  진행 상태를 확인하고, 끝나기를 기다리는 동안 다른 작업을 하지 않는다.

## 3. 권고 회수

```
web_agent_manager_experiment_summary { experimentId }        # 셀 하나
web_agent_manager_experiment_suite_summary { suiteId }       # 여러 상황을 묶은 스위트
```

셀 하나의 결과로 "어디엔 뭐가 좋다"를 말하지 않는다. 상황을 바꿔 여러 셀을 돌리고 스위트로 묶어야
한다 — 한 상황에서만 이긴 구성을 일반 권고로 올리면 다른 상황에서 반대로 작동한다.

`recommendation.grade`를 그대로 해석해 보고한다. 등급을 임의로 올리지 않는다.

| grade | 의미 | 보고 문장 |
| --- | --- | --- |
| `confirmed` | 표본 4회 이상이고 95% 구간이 겹치지 않음 | "이 상황에서는 X를 쓴다" |
| `tentative` | 표본이 모자라거나 구간이 겹침 | "X가 나아 보인다(관찰값)" |
| `indistinguishable` | 차이가 표본 변동 안 | "차이가 확인되지 않았다. 더 싼 쪽을 쓴다" |

`criterion`은 무엇으로 갈렸는지다: `deterministic_check`(fixture 검증 명령 통과율) →
`rubric`(블라인드 심사) → `cost`(토큰) 순서로 본 결과다. `costMultiple`이 크면 이겼어도
기본값이 아니라 조건부 선택지로 보고한다.

## 4. 결과를 읽을 때 주의

- **시간은 실작업 기준이다.** 공급자 한도로 기다린 시간은 빠져 있다. `waitedRuns`가 0이 아니면
  그 run들은 한도 대기 후 같은 세션을 이어 재개한 것이라 **토큰 지표가 오염**됐을 수 있다.
- **검사 통과율의 분모**에는 `skipped`(검증 명령 없음)와 `error`(실행 불가·시간 초과)가 빠져 있다.
  이는 fixture 환경 문제이지 산출물 결함이 아니다.
- 상황이 달라지면 순위가 뒤집힐 수 있다. 한 실험의 결과를 다른 과제 유형·저장소 규모로 일반화하지 않는다.

## 5. MCP가 없을 때

```bash
WEB_AGENT_MANAGER_ROOT="$(dirname "$(dirname "$(realpath .agents/skills/web-agent-manager-experiment 2>/dev/null || realpath .claude/skills/web-agent-manager-experiment)")")"
npm --silent --prefix "$WEB_AGENT_MANAGER_ROOT" run agent -- call experiment.summary '{"experimentId":"<실험 ID>"}'
npm --silent --prefix "$WEB_AGENT_MANAGER_ROOT" run agent -- call experiment.plan_start '{"experimentId":"<실험 ID>","stage":"screening","repetitions":4}'
```

실험 생성·Variant 추가·프리셋 승격은 관리자 확인이 필요한 작업이라 이 스킬로 하지 않는다.
사용자에게 웹 실험실 화면에서 진행하도록 안내한다.
