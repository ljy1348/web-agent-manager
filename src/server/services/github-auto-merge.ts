import { classifyPullRequestCheckRollup, type PullRequestCheckSnapshot } from "./verification-service";

export type GitHubCommandRunner = (command: string, args: string[], cwd: string) => Promise<string>;

export interface PullRequestMergeSnapshot extends Record<string, unknown> {
  number: number;
  state: string;
  isDraft: boolean;
  headRefOid: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
  autoMergeEnabled: boolean;
  checkSummary: PullRequestCheckSnapshot;
}

const DETAIL_FIELDS = [
  "number", "title", "state", "url", "body", "author", "comments", "reviews", "headRefName", "headRefOid", "baseRefName",
  "isDraft", "mergeable", "mergeStateStatus", "reviewDecision", "autoMergeRequest", "statusCheckRollup", "mergedAt", "createdAt", "updatedAt", "closedAt",
].join(",");

function conflict(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 409 });
}

export class GithubAutoMergeService {
  constructor(private readonly runner: GitHubCommandRunner) {}

  async read(cwd: string, number: number): Promise<PullRequestMergeSnapshot> {
    const raw = JSON.parse(await this.runner("gh", ["pr", "view", String(number), "--comments", "--json", DETAIL_FIELDS], cwd) || "null") as Record<string, unknown> | null;
    const actualNumber = Number(raw?.number);
    const headRefOid = String(raw?.headRefOid ?? "");
    if (!raw || actualNumber !== number || !/^[0-9a-f]{40,64}$/i.test(headRefOid)) throw new Error("GitHub PR 상태 응답이 올바르지 않습니다.");
    return {
      ...raw,
      number: actualNumber,
      state: String(raw.state ?? "").toUpperCase(),
      isDraft: raw.isDraft === true,
      headRefOid,
      mergeable: String(raw.mergeable ?? "UNKNOWN").toUpperCase(),
      mergeStateStatus: String(raw.mergeStateStatus ?? "UNKNOWN").toUpperCase(),
      reviewDecision: String(raw.reviewDecision ?? "").toUpperCase(),
      autoMergeEnabled: Boolean(raw.autoMergeRequest),
      checkSummary: classifyPullRequestCheckRollup(actualNumber, headRefOid, raw.statusCheckRollup),
    };
  }

  async set(cwd: string, number: number, options: { enabled: boolean; expectedHeadSha: string; method?: unknown; deleteBranch?: unknown }): Promise<PullRequestMergeSnapshot> {
    if (!/^[0-9a-f]{40,64}$/i.test(options.expectedHeadSha)) throw new Error("PR head SHA가 올바르지 않습니다.");
    const snapshot = await this.read(cwd, number);
    if (snapshot.state !== "OPEN") throw conflict("열린 PR만 조건부 자동 merge를 변경할 수 있습니다.");
    if (snapshot.headRefOid.toLowerCase() !== options.expectedHeadSha.toLowerCase()) throw conflict("PR head가 바뀌었습니다. 최신 상태를 확인한 뒤 다시 요청하세요.");
    if (!options.enabled) {
      if (!snapshot.autoMergeEnabled) return snapshot;
      await this.runner("gh", ["pr", "merge", String(number), "--disable-auto", "--match-head-commit", snapshot.headRefOid], cwd);
      return this.read(cwd, number);
    }
    if (snapshot.isDraft) throw conflict("draft PR에는 조건부 자동 merge를 예약할 수 없습니다.");
    if (snapshot.mergeable !== "MERGEABLE") throw conflict(snapshot.mergeable === "CONFLICTING" ? "충돌이 있는 PR은 자동 merge할 수 없습니다." : "PR merge 가능 상태를 아직 확인할 수 없습니다.");
    if (snapshot.reviewDecision === "CHANGES_REQUESTED") throw conflict("변경 요청 review가 남아 있어 자동 merge를 예약할 수 없습니다.");
    if (!snapshot.checkSummary.totalCount) throw conflict("확인할 PR check가 없어 자동 merge를 예약하지 않습니다.");
    if (snapshot.checkSummary.failedCount || snapshot.checkSummary.unavailableCount) throw conflict("실패하거나 판정 불가한 PR check가 있어 자동 merge를 예약하지 않습니다.");
    if (snapshot.autoMergeEnabled) return snapshot;
    const method = String(options.method ?? "squash");
    const methodFlag: Record<string, string> = { merge: "--merge", squash: "--squash", rebase: "--rebase" };
    const flag = methodFlag[method];
    if (!flag) throw new Error("유효하지 않은 병합 방식입니다.");
    if (options.deleteBranch !== undefined && typeof options.deleteBranch !== "boolean") throw new Error("deleteBranch는 boolean이어야 합니다.");
    await this.runner("gh", ["pr", "merge", String(number), flag, "--auto", "--match-head-commit", snapshot.headRefOid, ...(options.deleteBranch ? ["--delete-branch"] : [])], cwd);
    return this.read(cwd, number);
  }
}
