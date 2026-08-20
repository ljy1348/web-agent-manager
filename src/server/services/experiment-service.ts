import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { AppDatabase } from "../core/database";
import type { AppConfig } from "../core/config";
import { parseExperimentEvaluators, type ExperimentEvaluatorConfig, type ExperimentVariantConfig } from "../../shared/experiments";
import { AgentAccountService } from "./agent-accounts";
import { ExperimentRepository, type ExperimentRunRecord } from "./experiment-repository";
import { CodexExecRuntime } from "../experiments/codex-exec-runtime";
import { ClaudePrintRuntime } from "../experiments/claude-print-runtime";
import { ExperimentSkillManifestService } from "../experiments/skill-manifest";
import { ExperimentSkillBundleService } from "../experiments/skill-bundle";
import { ExperimentWorkspaceService } from "../experiments/experiment-workspace";
import { ExperimentFixtureStore } from "../experiments/fixture-store";
import { runDeterministicCheck } from "../experiments/deterministic-check";
import { recommend, rollupSuite, summarizeVariant, type SuiteCell, type SuiteRecommendation, type SuiteRollup, type VariantSummary } from "../experiments/suite-summary";
import { SingleHarness } from "../experiments/single-harness";
import { GraphHarness } from "../experiments/graph-harness";
import { createBuiltinExperimentHookBus } from "../experiments/builtin-hooks";
import { buildBlindSubjectPacket } from "../experiments/blind-subject-packet";
import { RubricEvaluationRunner, type RubricEvaluatorRuntime } from "../experiments/rubric-evaluation";
import { isRateLimitRecovered } from "./rate-limit-resume";

const execFileAsync = promisify(execFile);
const MAX_CONCURRENT_EXPERIMENT_OPERATIONS = 1;
const WORKSPACE_RETENTION_MS = 24 * 60 * 60 * 1_000;
const WORKSPACE_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
// 한도 대기 폴링 간격과 상한. usage-monitor가 60초마다 usage_status를 갱신하므로 같은 주기로 본다.
const LIMIT_POLL_INTERVAL_MS = 60_000;
const MAX_LIMIT_WAIT_MS = 6 * 60 * 60 * 1_000;
// 큐 항목이 전역 용량에 막혔을 때 다시 시도하기까지의 간격.
const PLAN_RETRY_INTERVAL_MS = 5_000;
const SAFE_PROCESS_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP", "TERM", "SHELL"] as const;

interface ActiveExperimentRun {
  harness: { cancel(runId: string): Promise<boolean>; execute(runId: string): Promise<ExperimentRunRecord> };
  promise: Promise<ExperimentRunRecord>;
}

interface ActiveExperimentEvaluation {
  runner: RubricEvaluationRunner;
  promise: Promise<ReturnType<ExperimentRepository["getEvaluation"]>>;
  workingDirectory: string;
}

// evaluator provider의 실제 CLI capability에 맞는 읽기 전용 Runtime 설정을 만든다.
export function buildEvaluatorVariantConfig(config: ExperimentEvaluatorConfig, accountId: number): ExperimentVariantConfig {
  return {
    schemaVersion: 1,
    runtime: {
      provider: config.provider, accountId, model: config.model,
      reasoningEffort: config.reasoningEffort, sandbox: "read-only",
      maxTurns: config.provider === "claude" ? null : 3,
    },
    skills: { mode: "none", enabled: [], disabled: [], profile: "native", baseline: "clean", additions: [], comparisonId: null, activation: "native" },
    harness: { type: "single", maxIterations: 1, minimumScore: null, maxNoImprovement: 0, workerCount: 2, secondaryRuntime: null },
    hooks: [], budget: { maxSeconds: 300, maxTokens: 100_000, maxCostUsd: 2 },
  };
}

export interface ExperimentRunDetail {
  run: ExperimentRunRecord;
  nodes: ReturnType<ExperimentRepository["listNodes"]>;
  events: ReturnType<ExperimentRepository["listEvents"]>;
  checkpoint: ReturnType<ExperimentRepository["getCheckpoint"]>;
  judgments: ReturnType<ExperimentRepository["listJudgments"]>;
  evaluations: Array<ReturnType<ExperimentRepository["getEvaluation"]> & {
    calls: ReturnType<ExperimentRepository["listEvaluationCalls"]>;
  }>;
}

export class ExperimentCapacityError extends Error {
  constructor() {
    super("측정 오염을 막기 위해 실험 run·평가는 현재 한 번에 하나만 실행할 수 있습니다.");
    this.name = "ExperimentCapacityError";
  }
}

// 서버의 비밀 환경을 제외하고 CLI 실행에 필요한 최소 환경과 계정 설정 변수만 만든다.
function restrictedEnvironment(accountEnvironment: Record<string, string>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_PROCESS_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, ...accountEnvironment };
}

// 실험 생성·격리 실행·취소와 공급자별 Runtime 조립을 관리한다.
export class ExperimentService {
  readonly repository: ExperimentRepository;
  private readonly workspaces: ExperimentWorkspaceService;
  private readonly fixtures: ExperimentFixtureStore;
  private readonly skills: ExperimentSkillManifestService;
  private readonly skillBundles: ExperimentSkillBundleService;
  private readonly active = new Map<string, ActiveExperimentRun>();
  private readonly activeEvaluations = new Map<string, ActiveExperimentEvaluation>();
  // 한도 대기 중인 run. 전역 동시 실행 슬롯을 점유하지 않아 큐가 멈추지 않게 한다.
  private readonly waitingOnLimit = new Set<string>();
  private readonly activePlans = new Map<string, Promise<void>>();
  private startingOperations = 0;
  private readonly evaluationWorkspaceRoot: string;
  private readonly evaluationCleanup: Promise<void>;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly database: AppDatabase,
    private readonly config: AppConfig,
    private readonly accounts: AgentAccountService,
  ) {
    this.repository = new ExperimentRepository(database);
    this.workspaces = new ExperimentWorkspaceService(database, config);
    this.fixtures = new ExperimentFixtureStore(config);
    this.skills = new ExperimentSkillManifestService({ homeDir: config.homeDir, rootDir: config.rootDir });
    this.skillBundles = new ExperimentSkillBundleService(this.skills, config.dataDir);
    this.evaluationWorkspaceRoot = path.resolve(config.dataDir, "evaluation-workspaces");
    const interrupted = this.repository.failInterruptedRuns();
    if (interrupted > 0) console.warn("[web-agent-manager:experiment]", "interrupted-runs-failed", { count: interrupted });
    const interruptedEvaluations = this.repository.failInterruptedEvaluations();
    if (interruptedEvaluations > 0) console.warn("[web-agent-manager:experiment]", "interrupted-evaluations-failed", { count: interruptedEvaluations });
    this.evaluationCleanup = this.cleanupEvaluationWorkspaces();
    void this.cleanupExpiredWorkspaces();
    this.cleanupTimer = setInterval(() => void this.cleanupExpiredWorkspaces(), WORKSPACE_CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  // 프로젝트·계정 기준 스킬 overlay 후보를 원본 경로 없이 반환한다.
  listSkillCandidates(projectId: number, provider: "codex" | "claude", accountId: number | null) {
    const project = this.database.prepare("SELECT path FROM projects WHERE id = ? AND active = 1").get(projectId) as { path: string } | undefined;
    if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
    const account = this.accounts.requireForProvider(provider, accountId);
    return this.skillBundles.catalog(provider, fsSync.realpathSync(project.path), account.config_dir);
  }

  // 같은 격리 비교 그룹에서 스킬 외 실행 조건이 달라지는 Variant를 차단한다.
  assertSkillIsolationVariant(experimentId: string, config: ExperimentVariantConfig): string | null {
    if (config.skills.profile !== "isolated_overlay") return null;
    if (!config.skills.comparisonId) throw new Error("격리 스킬 비교에는 comparisonId가 필요합니다.");
    const fingerprint = this.controlFingerprint(config);
    const conflict = this.repository.listVariants(experimentId).find((variant) => (
      variant.config.skills.profile === "isolated_overlay"
      && variant.config.runtime.provider === config.runtime.provider
      && variant.config.skills.comparisonId === config.skills.comparisonId
      && this.controlFingerprint(variant.config) !== fingerprint
    ));
    if (conflict) throw new Error(`스킬 비교 그룹의 비스킬 조건이 ${conflict.name} Variant와 다릅니다.`);
    return fingerprint;
  }

  // Variant 스냅샷과 격리 worktree를 만든 뒤 SingleHarness를 백그라운드 실행한다.
  async startVariant(variantId: string, pinnedBaseline?: string | null): Promise<ExperimentRunRecord> {
    if (this.operationCount() >= MAX_CONCURRENT_EXPERIMENT_OPERATIONS) throw new ExperimentCapacityError();
    this.startingOperations += 1;
    const variant = this.repository.getVariant(variantId);
    let experiment: ReturnType<ExperimentRepository["getExperiment"]> = null;
    let workspace: (Awaited<ReturnType<ExperimentWorkspaceService["create"]>> & { repositoryRoot: string }) | null = null;
    let fixtureMirror: string | null = null;
    let usesFixtureStore = false;
    let skillOverlay: ReturnType<ExperimentSkillBundleService["prepare"]> = null;
    const skillOverlays = new Map<"codex" | "claude", NonNullable<ReturnType<ExperimentSkillBundleService["prepare"]>>>();
    try {
      if (!variant) throw new Error("실험 변형을 찾을 수 없습니다.");
      if (variant.config.runtime.sandbox === "danger-full-access") {
        throw new Error("실험 Runtime은 저장소 밖 접근을 막을 수 있을 때까지 danger-full-access를 실행하지 않습니다.");
      }
      experiment = this.repository.getExperiment(variant.experimentId);
      if (!experiment) throw new Error("실험을 찾을 수 없습니다.");
      const account = this.accounts.requireForProvider(variant.config.runtime.provider, variant.config.runtime.accountId);
      const accountEnvironment = this.accounts.environment(account);
      const environment = restrictedEnvironment(accountEnvironment);
      const secondaryConfig = variant.config.harness.secondaryRuntime ?? variant.config.runtime;
      const secondaryAccount = this.accounts.requireForProvider(secondaryConfig.provider, secondaryConfig.accountId);
      const secondaryEnvironment = restrictedEnvironment(this.accounts.environment(secondaryAccount));
      const workspaceKey = crypto.randomUUID();
      // 실험 대상은 셋 중 하나다. fixture가 지정되면 고정 commit의 mirror worktree, greenfield는 빈 Git
      // 작업공간, 둘 다 아니면 기존처럼 등록 프로젝트의 현재 HEAD를 쓴다.
      const fixture = experiment.fixtureId ? this.repository.getFixture(experiment.fixtureId) : null;
      if (experiment.fixtureId && !fixture) throw new Error("실험에 지정된 저장소 fixture를 찾을 수 없습니다.");
      if (fixture && fixture.status !== "ready") throw new Error("적격성 게이트를 통과한 fixture만 실험에 쓸 수 있습니다.");
      if (fixture) {
        const created = await this.fixtures.createWorktree(fixture, workspaceKey);
        workspace = { ...created, repositoryRoot: await this.fixtures.ensureMirror(fixture) };
        fixtureMirror = workspace.repositoryRoot;
      } else if (experiment.taskKind === "greenfield") {
        const created = await this.fixtures.createEmptyWorkspace(workspaceKey);
        workspace = { ...created, repositoryRoot: created.root };
        fixtureMirror = null;
        usesFixtureStore = true;
      } else {
        workspace = await this.workspaces.create(experiment.projectId, workspaceKey, pinnedBaseline ?? null);
      }
      if (fixture) usesFixtureStore = true;
      const project = this.database.prepare("SELECT path FROM projects WHERE id = ? AND active = 1").get(experiment.projectId) as { path: string } | undefined;
      if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
      const sourceDirectory = fsSync.realpathSync(project.path);
      const priorBaseline = this.repository.listRuns({ experimentId: experiment.id, limit: 500 })
        .find((entry) => entry.baselineCommit)?.baselineCommit ?? null;
      if (priorBaseline && workspace.baselineCommit && priorBaseline !== workspace.baselineCommit) {
        throw new Error(`같은 실험의 Git 기준 commit이 바뀌었습니다. 기존 ${priorBaseline.slice(0, 12)}, 현재 ${workspace.baselineCommit.slice(0, 12)}`);
      }
      this.assertSkillIsolationVariant(experiment.id, variant.config);
      const runtimeAccounts: Array<{ provider: "codex" | "claude"; configDir: string | null }> = [
        { provider: variant.config.runtime.provider, configDir: account.config_dir },
        { provider: secondaryConfig.provider, configDir: secondaryAccount.config_dir },
      ];
      const providerAccounts = new Map<"codex" | "claude", string | null>();
      runtimeAccounts.forEach((entry) => {
        if (!providerAccounts.has(entry.provider)) providerAccounts.set(entry.provider, entry.configDir);
      });
      const projectSkills = variant.config.skills.profile === "isolated_overlay"
        ? [...providerAccounts].map(([provider, accountConfigDir]) => this.skillBundles.materializeProjectSkills({
          provider, sourceDirectory, targetDirectory: workspace!.workingDirectory, accountConfigDir,
        }))
        : [];
      // 공급자마다 installed 집합과 bundle 주입 의미가 다르므로 overlay를 공유하면 안 된다. graph에서
      // primary와 secondary가 서로 다른 공급자면 각자의 catalog로 만든 bundle을 따로 준다.
      for (const [provider, configDir] of providerAccounts) {
        const nativeDirectories = this.skills.catalog(provider, sourceDirectory, configDir)
          .filter((entry) => entry.includedByDefault)
          .map((entry) => entry.directory);
        const prepared = this.skillBundles.prepare({
          key: crypto.randomUUID(), provider,
          workingDirectory: sourceDirectory, accountConfigDir: configDir,
          additionalNativeDirectories: nativeDirectories,
          config: variant.config.skills,
        });
        if (prepared) skillOverlays.set(provider, prepared);
      }
      skillOverlay = skillOverlays.get(variant.config.runtime.provider) ?? null;
      const overlayFor = (provider: "codex" | "claude") => () => Promise.resolve(skillOverlays.get(provider) ?? null);
      const verifyOverlay = (snapshot: NonNullable<typeof skillOverlay>) => {
        this.skillBundles.verify(snapshot);
        projectSkills.forEach((entry) => this.skillBundles.verifyMaterialized(entry));
      };
      const manifest = () => Promise.resolve(this.skills.discover(
        variant.config.runtime.provider, workspace!.workingDirectory, account.config_dir,
      ));
      const runtime = variant.config.runtime.provider === "codex"
        ? new CodexExecRuntime({ environment, inheritProcessEnvironment: false, skillManifest: manifest, skillOverlay: overlayFor("codex"), verifySkillOverlay: verifyOverlay })
        : new ClaudePrintRuntime({ environment, inheritProcessEnvironment: false, skillManifest: manifest, skillOverlay: overlayFor("claude"), verifySkillOverlay: verifyOverlay });
      const secondaryManifest = () => Promise.resolve(this.skills.discover(
        secondaryConfig.provider, workspace!.workingDirectory, secondaryAccount.config_dir,
      ));
      const secondaryRuntime = secondaryConfig.provider === "codex"
        ? new CodexExecRuntime({ environment: secondaryEnvironment, inheritProcessEnvironment: false, skillManifest: secondaryManifest, skillOverlay: overlayFor("codex"), verifySkillOverlay: verifyOverlay })
        : new ClaudePrintRuntime({ environment: secondaryEnvironment, inheritProcessEnvironment: false, skillManifest: secondaryManifest, skillOverlay: overlayFor("claude"), verifySkillOverlay: verifyOverlay });
      const expiresAt = new Date(Date.now() + WORKSPACE_RETENTION_MS).toISOString();
      const run = this.repository.createRun({
        variantId,
        baselineCommit: workspace.baselineCommit,
        workingDirectory: workspace.workingDirectory,
        environmentSnapshot: {
          workspace: {
            root: workspace.root, workingDirectory: workspace.workingDirectory,
            baseline: "git-head", retention: "terminal-run-24h", expiresAt,
          },
          account: { id: account.id, label: account.label, provider: account.provider, configDirScoped: true },
          secondaryAccount: variant.config.harness.type === "single" ? null : {
            id: secondaryAccount.id, label: secondaryAccount.label, provider: secondaryAccount.provider, configDirScoped: true,
          },
          processEnvironment: { inherited: false, keys: Object.keys(environment).sort() },
          permissionSemantics: variant.config.runtime.provider === "claude"
            ? "native-permission-mode-not-os-sandbox"
            : "codex-sandbox",
          skillIsolation: skillOverlay ? {
            profile: skillOverlay.profile, baseline: skillOverlay.baseline, comparisonId: skillOverlay.comparisonId,
            activation: skillOverlay.activation,
            bundleRoot: skillOverlay.bundleRoot, digest: skillOverlay.digest,
            providerBundles: [...skillOverlays].map(([provider, prepared]) => ({
              provider, bundleRoot: prepared.bundleRoot, digest: prepared.digest,
            })),
            baselineSkills: skillOverlay.baselineSkills, additions: skillOverlay.additions,
            controlFingerprint: this.controlFingerprint(variant.config),
            projectSkills: projectSkills.map((entry) => ({
              provider: entry.provider, root: entry.root, digest: entry.digest, files: entry.files,
            })),
          } : { profile: "native" },
        },
      });
      const hookBus = createBuiltinExperimentHookBus(variant.config.hooks, workspace.workingDirectory);
      const isProviderLimited = (provider: "codex" | "claude", limitedAccountId: number | null) => this.isAccountRateLimited(provider, limitedAccountId ?? account.id);
      const waitForProviderLimit = (waitRunId: string, provider: "codex" | "claude", limitedAccountId: number | null, signal: AbortSignal) =>
        this.awaitProviderLimit(waitRunId, provider, limitedAccountId ?? account.id, signal);
      const harness = variant.config.harness.type === "single"
        ? new SingleHarness({
          repository: this.repository, runtimes: { [variant.config.runtime.provider]: runtime }, hookBus,
          isProviderLimited, waitForProviderLimit,
          // 에이전트가 스스로 검증할 수 있도록 fixture가 선언한 명령만 도구 허용 목록에 올린다.
          allowedCommands: fixture?.testCommand.length ? [fixture.testCommand] : [],
          // 명시 호출 활성화는 사용자가 슬래시 명령으로 스킬을 부르는 실사용 경로를 재현한다.
          // 프롬프트가 arm마다 달라지지만 그 호출 자체가 treatment이므로 의도된 차이다.
          promptPrefix: variant.config.skills.activation === "explicit"
            ? (skillOverlay?.additions ?? []).map((entry) => `/${entry.name}`).join(" ")
            : "",
        })
        : new GraphHarness({ repository: this.repository, primaryRuntime: runtime, secondaryRuntime, hookBus, isProviderLimited, waitForProviderLimit });
      const checkCommand = fixture?.testCommand ?? [];
      const checkDirectory = workspace.workingDirectory;
      const promise = harness.execute(run.id).then(async (finished) => {
        // 완성도의 1차 지표는 rubric이 아니라 fixture가 선언한 검증 명령의 통과 여부다.
        if (finished.status !== "completed" || !checkCommand.length) return finished;
        try {
          const result = await runDeterministicCheck(checkCommand, checkDirectory, { env: environment });
          return this.repository.recordDeterministicCheck(run.id, result);
        } catch (error) {
          console.error("[web-agent-manager:experiment]", "deterministic-check-failed", {
            runId: run.id, error: error instanceof Error ? error.message : String(error),
          });
          return finished;
        }
      });
      this.active.set(run.id, { harness, promise });
      void promise.catch((error) => {
        console.error("[web-agent-manager:experiment]", "run-failed", { runId: run.id, error: error instanceof Error ? error.message : String(error) });
      }).finally(() => this.active.delete(run.id));
      this.startingOperations -= 1;
      return this.repository.getRun(run.id)!;
    } catch (error) {
      this.startingOperations -= 1;
      if (workspace && experiment) {
        for (const prepared of skillOverlays.values()) {
          try { this.skillBundles.remove(prepared.bundleRoot); } catch { /* 원래 준비 오류를 보존한다. */ }
        }
        try {
          if (usesFixtureStore) await this.fixtures.remove(workspace.root, fixtureMirror);
          else await this.workspaces.remove(experiment.projectId, workspace.root);
        } catch (cleanupError) {
          console.error("[web-agent-manager:experiment]", "prepare-worktree-cleanup-failed", {
            workspace: workspace.root, error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }
      throw error;
    }
  }

  // 실험의 Variant별 지표를 접고 9-8의 승자 결정 순서로 권고를 만든다. 표와 점수는 결론의 재료일
  // 뿐이라, 어떤 기준으로 갈렸는지와 표본이 충분한지를 함께 돌려준다.
  summary(experimentId: string): { variants: VariantSummary[]; recommendation: SuiteRecommendation } {
    const experiment = this.repository.getExperiment(experimentId);
    if (!experiment) throw new Error("실험을 찾을 수 없습니다.");
    const summaries = this.repository.listVariants(experimentId).map((variant) => {
      const runs = this.repository.listRuns({ variantId: variant.id, limit: 500 });
      const scores = new Map<string, number[]>();
      for (const run of runs) {
        const judged = this.repository.listJudgments(run.id)
          .map((judgment) => judgment.score)
          .filter((score): score is number => typeof score === "number" && Number.isFinite(score));
        if (judged.length) scores.set(run.id, judged);
      }
      return summarizeVariant(variant.id, variant.name, runs, scores);
    });
    return { variants: summaries, recommendation: recommend(summaries) };
  }

  // 같은 실험의 기존 run이 쓰던 기준 commit을 이어 쓰고, 없으면 현재 HEAD를 고정한다.
  private resolvePlanBaseline(experimentId: string): string | null {
    const prior = this.repository.listRuns({ experimentId, limit: 500 }).find((entry) => entry.baselineCommit)?.baselineCommit;
    if (prior) return prior;
    const experiment = this.repository.getExperiment(experimentId);
    if (!experiment) return null;
    const project = this.database.prepare("SELECT path FROM projects WHERE id = ? AND active = 1").get(experiment.projectId) as { path: string } | undefined;
    if (!project) return null;
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], { cwd: fsSync.realpathSync(project.path), encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  }

  // 스위트에 묶인 모든 셀(실험)을 집계하고 셀을 가로지르는 조건부 권고까지 만든다.
  suiteSummary(suiteId: string): { suite: ReturnType<ExperimentRepository["getSuite"]>; cells: SuiteCell[]; rollup: SuiteRollup } {
    const suite = this.repository.getSuite(suiteId);
    if (!suite) throw new Error("실험 스위트를 찾을 수 없습니다.");
    const cells: SuiteCell[] = this.repository.listSuiteExperiments(suiteId).map((experiment) => {
      const { variants, recommendation } = this.summary(experiment.id);
      return { experimentId: experiment.id, label: experiment.name, variants, recommendation };
    });
    return { suite, cells, rollup: rollupSuite(cells) };
  }

  // 반복 실행을 arm 교차 순서로 펼친 계획을 만들고 백그라운드에서 하나씩 소비한다. 전역 동시 실행
  // 1개 제한을 그대로 지키며, 중간 실패는 항목에만 기록하고 큐를 멈추지 않는다.
  startRunPlan(experimentId: string, input: { stage?: unknown; repetitions?: unknown; cleanup?: unknown } = {}): ReturnType<ExperimentRepository["getRunPlan"]> {
    const stage = (input.stage ?? "screening") as "screening" | "grid" | "confirmation";
    const repetitions = Number(input.repetitions ?? 1);
    // 비교가 끝나면 격리 작업공간을 남길 이유가 없다. 평가를 붙일 계획만 cleanup:false로 보존한다.
    const cleanup = input.cleanup !== false;
    const plan = this.repository.createRunPlan({
      experimentId, stage, repetitions,
      // 계획을 시작할 때 기준 commit을 고정한다. 그러지 않으면 실행이 도는 동안 브랜치에 커밋 하나만
      // 쌓여도 남은 항목이 전부 "기준 commit이 바뀌었다"로 실패한다(실사용에서 13/16 실패).
      baselineCommit: this.resolvePlanBaseline(experimentId),
    });
    this.repository.setRunPlanStatus(plan.id, "running");
    const promise = this.consumeRunPlan(plan.id, cleanup ? experimentId : null).catch((error) => {
      console.error("[web-agent-manager:experiment]", "run-plan-failed", {
        planId: plan.id, error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => this.activePlans.delete(plan.id));
    this.activePlans.set(plan.id, promise);
    return this.repository.getRunPlan(plan.id);
  }

  // 계획을 취소하면 남은 queued 항목을 건너뛰고 진행 중 run은 그대로 둔다.
  cancelRunPlan(planId: string): ReturnType<ExperimentRepository["getRunPlan"]> {
    const plan = this.repository.getRunPlan(planId);
    if (!plan) throw new Error("실행 계획을 찾을 수 없습니다.");
    if (plan.status === "completed" || plan.status === "cancelled") return plan;
    return this.repository.setRunPlanStatus(planId, "cancelled");
  }

  // 큐를 순서대로 하나씩 실행한다. 용량이 차 있으면 잠시 기다렸다 다시 시도한다.
  private async consumeRunPlan(planId: string, cleanupExperimentId: string | null = null): Promise<void> {
    for (;;) {
      const plan = this.repository.getRunPlan(planId);
      const item = this.repository.nextQueuedPlanItem(planId);
      if (!item) break;
      this.repository.updatePlanItem(item.id, { status: "running" });
      try {
        const run = await this.startVariant(item.variantId, plan?.baselineCommit ?? null);
        const active = this.active.get(run.id);
        const finished = active ? await active.promise : run;
        this.repository.updatePlanItem(item.id, {
          status: finished.status === "completed" ? "completed" : "failed",
          runId: run.id,
          error: finished.status === "completed" ? null : finished.terminationReason ?? finished.status,
        });
      } catch (error) {
        if (error instanceof ExperimentCapacityError) {
          // 다른 작업이 슬롯을 쓰는 중이면 항목을 되돌리고 잠시 뒤 다시 시도한다.
          this.repository.updatePlanItem(item.id, { status: "queued" });
          await this.sleep(PLAN_RETRY_INTERVAL_MS, new AbortController().signal);
          continue;
        }
        this.repository.updatePlanItem(item.id, {
          status: "failed", error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const plan = this.repository.getRunPlan(planId);
    if (plan && plan.status !== "cancelled") this.repository.setRunPlanStatus(planId, "completed");
    if (cleanupExperimentId) {
      const result = await this.cleanupWorkspaces({ experimentId: cleanupExperimentId });
      console.info("[web-agent-manager:experiment]", "plan-cleanup", { planId, ...result });
    }
  }

  // 실행 상세와 최근 이벤트·node·체크포인트를 한 응답으로 묶는다.
  detail(runId: string, afterSequence = 0): ExperimentRunDetail {
    const run = this.repository.getRun(runId);
    if (!run) throw new Error("실험 실행을 찾을 수 없습니다.");
    return {
      run,
      nodes: this.repository.listNodes(runId),
      events: this.repository.listEvents(runId, afterSequence, 1_000),
      checkpoint: this.repository.getCheckpoint(runId),
      judgments: this.repository.listJudgments(runId),
      evaluations: this.repository.listEvaluations({ runId }).map((evaluation) => ({
        ...this.publicEvaluation(evaluation), calls: this.repository.listEvaluationCalls(evaluation.id),
      })),
    };
  }

  // 완료 run의 블라인드 패킷을 복수 evaluator에게 순차 전달하고 평가를 백그라운드 실행한다.
  async startEvaluation(runId: string, evaluatorInput: unknown): Promise<NonNullable<ReturnType<ExperimentRepository["getEvaluation"]>>> {
    await this.evaluationCleanup;
    if (this.operationCount() >= MAX_CONCURRENT_EXPERIMENT_OPERATIONS) throw new ExperimentCapacityError();
    this.startingOperations += 1;
    let evaluation: ReturnType<ExperimentRepository["getEvaluation"]> = null;
    let evaluationDirectory: string | null = null;
    try {
      const evaluators = parseExperimentEvaluators(evaluatorInput);
      const run = this.repository.getRun(runId);
      if (!run || run.status !== "completed" || !run.workingDirectory) throw new Error("완료되고 보존 worktree가 있는 run만 평가할 수 있습니다.");
      const experiment = this.repository.getExperiment(run.experimentId);
      if (!experiment) throw new Error("실험을 찾을 수 없습니다.");
      const finalAnswer = this.repository.latestAssistantMessage(run.id);
      if (!finalAnswer) throw new Error("평가할 최종 assistant 답변이 없습니다.");
      const prepared = evaluators.map((config) => {
        const account = this.accounts.requireForProvider(config.provider, config.accountId);
        const environment = restrictedEnvironment(this.accounts.environment(account));
        const runtimeConfig = buildEvaluatorVariantConfig(config, account.id);
        return { config, account, environment, runtimeConfig };
      });
      evaluation = this.repository.createEvaluation({
        experimentId: experiment.id, method: "rubric",
        rubric: { schemaVersion: 1, promptVersion: "rubric-v1", criteria: experiment.rubric },
        subjects: [{ runId: run.id, blindLabel: `후보-${crypto.randomBytes(6).toString("hex")}`, presentationOrder: 1 }],
      });
      const subject = evaluation.subjects[0]!;
      const candidate = await buildBlindSubjectPacket({
        blindLabel: subject.blindLabel, taskCommand: experiment.command,
        finalAnswer, workingDirectory: run.workingDirectory,
      });
      evaluationDirectory = await this.createEvaluationWorkspace(evaluation.id);
      const runtimeEntries: RubricEvaluatorRuntime[] = prepared.map(({ config, account, environment, runtimeConfig }) => {
        const manifest = () => Promise.resolve(this.skills.discover(config.provider, evaluationDirectory!, account.config_dir));
        const runtime = config.provider === "codex"
          ? new CodexExecRuntime({ environment, inheritProcessEnvironment: false, skillManifest: manifest })
          : new ClaudePrintRuntime({ environment, inheritProcessEnvironment: false, skillManifest: manifest });
        const call = this.repository.createEvaluationCall({
          evaluationId: evaluation!.id, idempotencyKey: `${run.id}:${config.label}:rubric-v1`,
          evaluatorLabel: config.label, evaluatorProvider: config.provider,
          evaluatorModel: config.model, evaluatorFamily: config.family, evaluatorAccountId: account.id,
        });
        return { callId: call.id, config, runtimeConfig, runtime };
      });
      if (experiment.design.randomizeOrder) this.shuffle(runtimeEntries);
      const subjectModel = this.repository.listNodes(run.id).find((node) => node.role === "worker")?.model ?? run.configSnapshot.runtime.model;
      const runner = new RubricEvaluationRunner(this.repository);
      const directory = evaluationDirectory;
      const promise = runner.execute({
        evaluationId: evaluation.id, runId: run.id, workingDirectory: directory,
        task: experiment.command, candidate,
        subjectProvider: run.configSnapshot.runtime.provider,
        subjectModel, subjectFamily: run.configSnapshot.runtime.provider,
        evaluators: runtimeEntries,
      });
      this.activeEvaluations.set(evaluation.id, { runner, promise, workingDirectory: directory });
      void promise.catch((error) => {
        console.error("[web-agent-manager:experiment]", "evaluation-failed", {
          evaluationId: evaluation!.id, error: error instanceof Error ? error.message : String(error),
        });
      }).finally(async () => {
        this.activeEvaluations.delete(evaluation!.id);
        try {
          await this.removeEvaluationWorkspace(directory);
        } catch (error) {
          console.error("[web-agent-manager:experiment]", "evaluation-workspace-remove-failed", {
            evaluationId: evaluation!.id, error: error instanceof Error ? error.message : String(error),
          });
        }
      });
      this.startingOperations -= 1;
      return this.publicEvaluation(this.repository.getEvaluation(evaluation.id)!);
    } catch (error) {
      this.startingOperations -= 1;
      if (evaluationDirectory) await this.removeEvaluationWorkspace(evaluationDirectory);
      if (evaluation && ["queued", "running"].includes(evaluation.status)) {
        const current = this.repository.getEvaluation(evaluation.id);
        if (current?.status === "queued") this.repository.transitionEvaluation(evaluation.id, "cancelled", error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  // 평가 라운드·호출·judgment를 한 응답으로 묶되 진행 중 blind mapping은 숨긴다.
  evaluationDetail(evaluationId: string): {
    evaluation: NonNullable<ReturnType<ExperimentRepository["getEvaluation"]>>;
    calls: ReturnType<ExperimentRepository["listEvaluationCalls"]>;
    judgments: ReturnType<ExperimentRepository["listJudgments"]>;
  } {
    const evaluation = this.repository.getEvaluation(evaluationId);
    if (!evaluation) throw new Error("평가 라운드를 찾을 수 없습니다.");
    const judgments = evaluation.subjects.flatMap((subject) => this.repository.listJudgments(subject.runId))
      .filter((judgment) => judgment.evaluationId === evaluation.id);
    return { evaluation: this.publicEvaluation(evaluation), calls: this.repository.listEvaluationCalls(evaluation.id), judgments };
  }

  // 현재 프로세스가 실행 중인 평가를 중단하고 이미 성공한 judgment는 partial로 보존한다.
  async cancelEvaluation(evaluationId: string): Promise<NonNullable<ReturnType<ExperimentRepository["getEvaluation"]>>> {
    const active = this.activeEvaluations.get(evaluationId);
    if (!active) {
      const evaluation = this.repository.getEvaluation(evaluationId);
      if (!evaluation) throw new Error("평가 라운드를 찾을 수 없습니다.");
      if (["completed", "partial", "failed", "cancelled"].includes(evaluation.status)) return this.publicEvaluation(evaluation);
      return this.publicEvaluation(this.repository.transitionEvaluation(evaluation.id, "cancelled", "평가 프로세스 소유권이 없어 원장만 취소했습니다."));
    }
    await active.runner.cancel();
    await active.promise;
    return this.publicEvaluation(this.repository.getEvaluation(evaluationId)!);
  }

  // 현재 프로세스가 실행 중인 run을 취소한다.
  async cancel(runId: string): Promise<ExperimentRunRecord> {
    const active = this.active.get(runId);
    if (!active) {
      const run = this.repository.getRun(runId);
      if (!run) throw new Error("실험 실행을 찾을 수 없습니다.");
      if (["completed", "failed", "cancelled", "budget_exceeded"].includes(run.status)) return run;
      return this.repository.transitionRun({ runId, status: "cancelled", terminationReason: "cancelled", error: "실행 프로세스 소유권이 없어 원장만 취소했습니다." });
    }
    await active.harness.cancel(runId);
    return await active.promise;
  }

  // 서버 종료 전에 활성 실험 Runtime을 모두 취소하고 정리 완료를 기다린다.
  async shutdown(): Promise<void> {
    clearInterval(this.cleanupTimer);
    const entries = [...this.active.entries()];
    await Promise.allSettled(entries.map(async ([runId, active]) => {
      await active.harness.cancel(runId);
      await active.promise;
    }));
    const evaluations = [...this.activeEvaluations.values()];
    await Promise.allSettled(evaluations.map(async (active) => {
      await active.runner.cancel();
      await active.promise;
    }));
  }

  // 준비 중 작업까지 포함한 전역 실험 CLI 점유 수를 반환한다.
  private operationCount(): number {
    return Math.max(0, this.active.size - this.waitingOnLimit.size) + this.activeEvaluations.size + this.startingOperations;
  }

  // 한도가 풀릴 때까지 usage_status를 폴링한다. 대기 중에는 전역 실행 슬롯을 반납해 다른 계정·공급자
  // 작업이 그동안 진행될 수 있게 하고, 상한을 넘거나 취소되면 재개하지 않는다.
  private async awaitProviderLimit(runId: string, provider: "codex" | "claude", accountId: number, signal: AbortSignal): Promise<boolean> {
    this.waitingOnLimit.add(runId);
    try {
      const deadline = Date.now() + MAX_LIMIT_WAIT_MS;
      while (Date.now() < deadline) {
        if (signal.aborted) return false;
        const slept = await this.sleep(LIMIT_POLL_INTERVAL_MS, signal);
        if (!slept || signal.aborted) return false;
        if (!await this.isAccountRateLimited(provider, accountId)) return true;
      }
      return false;
    } finally {
      this.waitingOnLimit.delete(runId);
    }
  }

  // 취소 신호가 오면 즉시 깨는 대기. 서버 종료 때 대기가 남지 않도록 타이머를 unref한다.
  private sleep(durationMs: number, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(true); }, durationMs);
      timer.unref?.();
      const onAbort = () => { clearTimeout(timer); resolve(false); };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // 실행 실패 시점에 그 계정이 실제로 사용량 한도에 걸려 있었는지 usage-monitor가 갱신한 상태로 본다.
  // CLI 오류 문구를 새로 파싱하지 않고 이미 검증된 데이터만 쓰며, 잔여 사용량이 완전히 0일 때만
  // 한도로 판정해 일반 실행 오류를 한도로 잘못 분류하지 않는다.
  private async isAccountRateLimited(provider: "codex" | "claude", accountId: number): Promise<boolean> {
    const row = this.database.prepare(
      "SELECT reset_at AS resetAt, remaining_percent AS remainingPercent FROM usage_status WHERE provider = ? AND account_id = ?",
    ).get(provider, accountId) as { resetAt: string | null; remainingPercent: number | null } | undefined;
    if (!row || row.remainingPercent === null || row.remainingPercent > 0) return false;
    return !isRateLimitRecovered(row.resetAt, row.remainingPercent, new Date());
  }

  // 스킬 treatment를 제외한 실행 조건의 안정된 SHA-256 fingerprint를 만든다.
  private controlFingerprint(config: ExperimentVariantConfig): string {
    return crypto.createHash("sha256").update(JSON.stringify({
      schemaVersion: config.schemaVersion,
      runtime: config.runtime,
      harness: config.harness,
      hooks: config.hooks,
      budget: config.budget,
      skillProfile: config.skills.profile,
      skillActivation: config.skills.activation,
      comparisonId: config.skills.comparisonId,
    })).digest("hex");
  }

  // evaluator 실행 순서를 Fisher-Yates 방식으로 무작위화한다.
  private shuffle<T>(values: T[]): void {
    for (let index = values.length - 1; index > 0; index -= 1) {
      const selected = crypto.randomInt(index + 1);
      [values[index], values[selected]] = [values[selected]!, values[index]!];
    }
  }

  // 진행 중 평가에서는 run ID가 담긴 blind map을 API 응답에서 제거한다.
  private publicEvaluation<T extends NonNullable<ReturnType<ExperimentRepository["getEvaluation"]>>>(evaluation: T): T {
    return ["queued", "running"].includes(evaluation.status) ? { ...evaluation, blindMap: {} } : evaluation;
  }

  // 피험 저장소와 분리된 빈 Git 디렉터리를 evaluator의 읽기 전용 cwd로 만든다.
  private async createEvaluationWorkspace(evaluationId: string): Promise<string> {
    await fs.mkdir(this.evaluationWorkspaceRoot, { recursive: true, mode: 0o700 });
    const directory = path.join(this.evaluationWorkspaceRoot, evaluationId);
    await fs.mkdir(directory, { mode: 0o700 });
    await execFileAsync("git", ["init", "--quiet"], { cwd: directory, timeout: 30_000 });
    return directory;
  }

  // 앱 관리 평가 root 바로 아래의 정확한 디렉터리만 제거한다.
  private async removeEvaluationWorkspace(directory: string): Promise<void> {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== this.evaluationWorkspaceRoot) throw new Error("평가 작업공간 정리 경로가 관리 root 밖입니다.");
    await fs.rm(resolved, { recursive: true, force: true });
  }

  // 서버 재시작 뒤 남은 비밀 없는 임시 평가 디렉터리를 관리 root 안에서 정리한다.
  private async cleanupEvaluationWorkspaces(): Promise<void> {
    try {
      const entries = await fs.readdir(this.evaluationWorkspaceRoot, { withFileTypes: true });
      await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => this.removeEvaluationWorkspace(path.join(this.evaluationWorkspaceRoot, entry.name))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[web-agent-manager:experiment]", "evaluation-workspace-cleanup-failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  // 끝난 run의 격리 작업공간과 스킬 bundle을 지금 정리한다. 기본 보존 24시간은 결과를 평가할 시간을
  // 벌기 위한 것이라, 비교가 끝났으면 기다릴 이유가 없다. 실험·스위트 단위로 좁혀 지울 수 있다.
  async cleanupWorkspaces(filter: { experimentId?: string; suiteId?: string } = {}): Promise<{ removed: number; failed: number }> {
    const conditions: string[] = [
      "r.status IN ('completed', 'failed', 'cancelled', 'budget_exceeded')",
      // 블라인드 평가는 피험 worktree의 diff를 읽으므로, 평가가 걸린 run은 남긴다.
      "NOT EXISTS (SELECT 1 FROM experiment_evaluation_subjects s WHERE s.run_id = r.id)",
    ];
    const params: unknown[] = [];
    if (filter.experimentId) { conditions.push("r.experiment_id = ?"); params.push(filter.experimentId); }
    if (filter.suiteId) { conditions.push("e.suite_id = ?"); params.push(filter.suiteId); }
    const rows = this.database.prepare(`
      SELECT r.id, r.environment_snapshot_json, e.project_id
      FROM experiment_runs r JOIN experiments e ON e.id = r.experiment_id
      WHERE ${conditions.join(" AND ")}
    `).all(...params) as Array<{ id: string; environment_snapshot_json: string; project_id: number }>;
    let removed = 0;
    let failed = 0;
    for (const row of rows) {
      if (await this.removeRunWorkspace(row)) removed += 1;
      else failed += 1;
    }
    return { removed, failed };
  }

  // 종료 후 24시간이 지난 run의 보존 worktree만 주기적으로 Git 메타데이터와 함께 정리한다.
  private async cleanupExpiredWorkspaces(): Promise<void> {
    const rows = this.database.prepare(`
      SELECT r.id, r.environment_snapshot_json, e.project_id
      FROM experiment_runs r
      JOIN experiments e ON e.id = r.experiment_id
      WHERE r.status IN ('completed', 'failed', 'cancelled', 'budget_exceeded')
        AND r.finished_at IS NOT NULL
        AND julianday(r.finished_at) <= julianday('now', '-1 day')
    `).all() as Array<{ id: string; environment_snapshot_json: string; project_id: number }>;
    for (const row of rows) await this.removeRunWorkspace(row);
  }

  // run 하나의 worktree와 스킬 bundle을 제거한다. fixture·빈 작업공간은 Git worktree로 등록돼 있지
  // 않으므로 프로젝트 worktree 제거가 실패하면 앱 관리 경로 제거로 넘어간다.
  private async removeRunWorkspace(row: { id: string; environment_snapshot_json: string; project_id: number }): Promise<boolean> {
    try {
      const snapshot = JSON.parse(row.environment_snapshot_json) as {
        workspace?: { root?: unknown };
        skillIsolation?: { bundleRoot?: unknown; providerBundles?: Array<{ bundleRoot?: unknown }> };
      };
      const workspaceRoot = snapshot.workspace?.root;
      if (typeof workspaceRoot !== "string") return false;
      if (!fsSync.existsSync(workspaceRoot)) return false;
      try {
        await this.workspaces.remove(row.project_id, workspaceRoot);
      } catch {
        await this.fixtures.remove(workspaceRoot, null);
      }
      // 공급자별로 나뉜 bundle까지 모두 지운다. 예전 run은 단일 bundleRoot만 가진다.
      const bundleRoots = [
        snapshot.skillIsolation?.bundleRoot,
        ...(snapshot.skillIsolation?.providerBundles ?? []).map((entry) => entry.bundleRoot),
      ].filter((entry): entry is string => typeof entry === "string");
      for (const bundleRoot of new Set(bundleRoots)) {
        try { this.skillBundles.remove(bundleRoot); } catch { /* worktree 정리는 이미 끝났다. */ }
      }
      console.info("[web-agent-manager:experiment]", "worktree-removed", { runId: row.id });
      return true;
    } catch (error) {
      console.error("[web-agent-manager:experiment]", "worktree-cleanup-failed", {
        runId: row.id, error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
