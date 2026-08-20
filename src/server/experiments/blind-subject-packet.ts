import { collectGitChangeSnapshot } from "./git-change-snapshot";
const MAX_FINAL_ANSWER_CHARS = 24_000;
const MAX_DIFF_CHARS = 60_000;
const PROVIDER_FINGERPRINT = /claude|anthropic|codex|openai|gpt-[\w.-]*|sonnet|opus|haiku|session[_ -]?id|co-authored-by/gi;

export interface BlindSubjectPacket {
  blindLabel: string;
  taskCommand: string;
  finalAnswer: string;
  trackedDiff: string | null;
  diffCoverage: "tracked-and-untracked";
  leakageRedactions: number;
  truncations: string[];
}

// 모델·공급자 지문을 일정한 자리표시자로 바꾸고 치환 건수를 함께 반환한다.
function redactFingerprints(value: string): { text: string; count: number } {
  let count = 0;
  return {
    text: value.replace(PROVIDER_FINGERPRINT, () => {
      count += 1;
      return "[공급자 식별자 제거]";
    }),
    count,
  };
}

// 길이 상한을 넘는 텍스트를 명시적인 절단 표식과 함께 제한한다.
function truncate(value: string, maximum: number, label: string, truncations: string[]): string {
  if (value.length <= maximum) return value;
  truncations.push(label);
  return `${value.slice(0, maximum)}\n[이후 ${value.length - maximum}자 절단]`;
}

// 피험 worktree에서 공급자 중립 최종 답변과 tracked·untracked diff만 allowlist 패킷으로 조립한다.
export async function buildBlindSubjectPacket(input: {
  blindLabel: string;
  taskCommand: string;
  finalAnswer: string;
  workingDirectory: string;
}): Promise<BlindSubjectPacket> {
  const truncations: string[] = [];
  let trackedDiff = "";
  try {
    trackedDiff = (await collectGitChangeSnapshot(input.workingDirectory)).diff;
  } catch (error) {
    throw new Error("평가용 tracked diff를 읽지 못했습니다.", { cause: error });
  }
  const answer = redactFingerprints(truncate(input.finalAnswer, MAX_FINAL_ANSWER_CHARS, "finalAnswer", truncations));
  const diff = redactFingerprints(truncate(trackedDiff, MAX_DIFF_CHARS, "trackedDiff", truncations));
  return {
    blindLabel: input.blindLabel,
    taskCommand: input.taskCommand,
    finalAnswer: answer.text,
    trackedDiff: diff.text || null,
    diffCoverage: "tracked-and-untracked",
    leakageRedactions: answer.count + diff.count,
    truncations,
  };
}
