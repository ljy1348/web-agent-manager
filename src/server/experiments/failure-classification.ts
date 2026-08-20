import type { ExperimentTerminationReason } from "../../shared/experiments";

// 컨텍스트 초과를 일반 실행 오류와 분리한다. 규모 축(9-3)에서 대형 저장소 arm이 죽었을 때 "구성이
// 나빴는지"와 "모델 컨텍스트가 모자랐는지"를 구분하지 못하면 규모를 잰다는 실험 자체가 성립하지 않는다.
//
// 표식은 설치된 CLI 번들에서 실측한 문자열이다. Claude Code 2.1.232에는
// `context_window_exceeded`, `model_context_window_exceeded`, `prompt is too long`,
// `input length and `max_tokens` exceed context limit`이,
// Codex 0.146.0에는 `context_window_exceeded`, `context length`가 들어 있다. 실제 초과 상황의
// 라이브 출력까지 확인한 것은 아니므로 새 표식이 발견되면 여기에 더한다.
const CONTEXT_MARKERS = [
  "model_context_window_exceeded",
  "context_window_exceeded",
  "context_length_exceeded",
  "context length",
  "context window",
  "prompt is too long",
  "exceed context limit",
  "maximum context length",
];

// 정규화한 문자열에서 컨텍스트 초과 표식을 찾는다. 표식이 없으면 판단하지 않는다.
export function looksLikeContextOverflow(...values: Array<unknown>): boolean {
  const haystack = values
    .map((value) => (typeof value === "string" ? value : value == null ? "" : JSON.stringify(value)))
    .join(" ")
    .toLowerCase();
  if (!haystack.trim()) return false;
  return CONTEXT_MARKERS.some((marker) => haystack.includes(marker.toLowerCase()));
}

// 일반 실행 오류만 좁힌다. 이미 구조화된 종료 이유가 있으면 그대로 둔다.
export function classifyFailureReason(
  reason: ExperimentTerminationReason,
  ...evidence: Array<unknown>
): ExperimentTerminationReason {
  if (reason !== "runtime_error") return reason;
  return looksLikeContextOverflow(...evidence) ? "context_exceeded" : reason;
}
