/**
 * InProcessRunner (design doc §4.6): ChildRunner backed by an in-process
 * child session created through an injected CreateSessionFn.
 *
 * Zero pi dependency — the real session factory lives in pi-runtime.ts and
 * tests inject fakes.
 *
 * Lifecycle per child ("generation" = one prompt..settle cycle; resume()
 * starts a new generation on the same session):
 * - a per-generation admission slot is acquired via the optional `acquire`
 *   hook (the registry uses it for the global concurrency cap);
 * - `timeoutMs` is a hard timeout: abort -> result {status:"interrupted", error:"timeout"};
 * - a stall watchdog aborts the child after `stallMs` (default 10min) without
 *   any session event. A stall is treated as transient (a silently dropped
 *   provider stream): the child is aborted and auto-resumed on the SAME
 *   session with a continuation prompt, up to `stallRetries` times
 *   (default 1). Only when the retries are exhausted does the run settle as
 *   {status:"failed", error:"stalled"}. Retries keep the admission slot and
 *   the result promise; the transcript so far is preserved.
 * - the retry waits for the abort to finish before re-prompting: real pi
 *   rejects prompt() while a run is still active ("Agent is already
 *   processing"). The wait is bounded by `stallMs` — an abort that never
 *   completes means the stream ignored it and the session is dead.
 * - `timeoutMs` is a budget for the whole user turn: stall retries arm only
 *   the remaining time, and a timeout landing during a retry delay still
 *   fires (it is not masked by the retired generation).
 * - session/prompt exceptions -> {status:"failed", error}.
 *
 * Note on pi semantics: AgentSession.prompt() resolves only after the whole
 * agent run settles, so the prompt promise itself is the completion signal;
 * waitForIdle() is awaited afterwards as belt-and-braces for queued
 * steer/followUp processing.
 */
import { realClock, TimerScope, type Clock, type ClockTimer } from "../clock";
import type {
  ChildResult,
  ChildRunRequest,
  ChildRunner,
  ChildSessionAdapter,
  ChildStatus,
  CreateSessionFn,
  DisposableChildHandle,
} from "./types";

/** Inactivity abort. Paused while a tool is executing or a need_decision is pending. */
export const DEFAULT_STALL_MS = 5 * 60 * 1000;
/** Auto-resumes per stall before the run settles as failed. 0 disables retries. */
export const DEFAULT_STALL_RETRIES = 1;
/** Pause between the stall abort and the retry prompt (ms). */
export const DEFAULT_STALL_RETRY_DELAY_MS = 5_000;

/** Continuation prompt for a stall retry: the transcript holds the context. */
export function stallRetryPrompt(stallMs: number): string {
  return (
    `[system: the previous attempt stalled with no activity for over ${Math.round(stallMs / 1000)}s ` +
    "and was interrupted mid-run; the transcript so far is preserved. Continue from where you left off.]"
  );
}

export interface InProcessRunnerOptions {
  createSession: CreateSessionFn;
  /** Stall watchdog timeout (ms). Default 10 minutes. */
  stallMs?: number;
  /** Auto-resume attempts after a stall. Default 1; 0 settles stalled at once. */
  stallRetries?: number;
  /** Delay between stall abort and the retry prompt (ms). Default 5s. */
  stallRetryDelayMs?: number;
  /** Called on every stall detection (before any retry), with the 1-based attempt. */
  onStall?: (childId: string, attempt: number) => void;
  /** Shared time source and scheduler. */
  clock?: Clock;
  /**
   * Per-generation admission hook. Awaited before each (re)start; the
   * resolved releaser is called when the generation settles. Rejecting
   * cancels the generation as {status:"interrupted", error}.
   */
  acquire?: (req: ChildRunRequest) => Promise<() => void>;
  /**
   * Called after the child's conversation may have changed (a message or
   * tool finished, or the generation settled). Used to persist transcripts.
   */
  onActivity?: (childId: string) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class InProcessRunner implements ChildRunner {
  private readonly opts: InProcessRunnerOptions;

  constructor(opts: InProcessRunnerOptions) {
    this.opts = opts;
  }

  async start(req: ChildRunRequest): Promise<DisposableChildHandle> {
    const handle = new InProcessChildHandle(req, this.opts);
    await handle.launch();
    return handle;
  }
}

class InProcessChildHandle implements DisposableChildHandle {
  private readonly req: ChildRunRequest;
  private readonly createSession: CreateSessionFn;
  private readonly stallMs: number;
  private readonly stallRetries: number;
  private readonly stallRetryDelayMs: number;
  private readonly onStall?: (childId: string, attempt: number) => void;
  private readonly clock: Clock;
  private readonly acquire?: (req: ChildRunRequest) => Promise<() => void>;
  private readonly onActivity?: (childId: string) => void;

  private session: ChildSessionAdapter | null = null;
  private resolvedModel_: string | undefined;
  private unsubscribe: (() => void) | null = null;
  private status_: ChildStatus = "pending";
  private lastEvent: number;
  /** Generation start (reset per generation; durationMs is relative to runStartedAt). */
  private startedAt: number;
  /** User-turn start: reset on launch and user resume(), not on stall retries. */
  private runStartedAt: number;
  /**
   * When the timeout budget starts counting. Set after admission and session
   * creation (queue wait must not eat the budget), and NOT reset by stall
   * retries — a stall already consumes budget time by definition.
   */
  private turnBudgetStart: number;
  /** Abort kicked off by the latest stall detection; awaited (bounded) by the retry. */
  private abortPromise: Promise<void> | null = null;
  private generation = 0;
  private settledFlag = false;
  private resolveResult!: (result: ChildResult) => void;
  private resultPromise: Promise<ChildResult>;
  private timeoutTimer: ClockTimer | null = null;
  private stallTimer: ClockTimer | null = null;
  private retryTimer: { scope: TimerScope; id: ClockTimer } | null = null;
  private timerScope: TimerScope | null = null;
  /** Stall detections so far (across generations, per handle). */
  private stallAttempts = 0;
  /** Generation retired by a stall detection awaiting its retry. */
  private retiredGen: number | null = null;
  private releaseSlot: (() => void) | null = null;
  private disposed = false;
  /** Nested tool_execution_start/end. Stall stays paused while > 0. */
  private toolDepth = 0;
  /** contact_supervisor need_decision. Stall stays paused while true. */
  private decisionPaused = false;

  constructor(req: ChildRunRequest, opts: InProcessRunnerOptions) {
    this.req = req;
    this.createSession = opts.createSession;
    this.stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
    const rawRetries = opts.stallRetries ?? DEFAULT_STALL_RETRIES;
    this.stallRetries = Number.isFinite(rawRetries)
      ? Math.max(0, Math.floor(rawRetries))
      : DEFAULT_STALL_RETRIES;
    const rawDelay = opts.stallRetryDelayMs ?? DEFAULT_STALL_RETRY_DELAY_MS;
    this.stallRetryDelayMs = Number.isFinite(rawDelay)
      ? Math.max(0, Math.floor(rawDelay))
      : DEFAULT_STALL_RETRY_DELAY_MS;
    this.onStall = opts.onStall;
    this.clock = opts.clock ?? realClock;
    this.acquire = opts.acquire;
    this.onActivity = opts.onActivity;
    this.startedAt = this.clock.now();
    this.runStartedAt = this.startedAt;
    this.turnBudgetStart = this.startedAt;
    this.lastEvent = this.startedAt;
    this.resultPromise = new Promise((resolve) => {
      this.resolveResult = resolve;
    });
  }

  get childId(): string {
    return this.req.childId;
  }

  /** Current generation's result promise (see Appendix B note on resume). */
  get result(): Promise<ChildResult> {
    return this.resultPromise;
  }

  status(): ChildStatus {
    return this.status_;
  }

  lastEventAt(): number {
    return this.lastEvent;
  }

  resolvedModel(): string | undefined {
    return this.resolvedModel_ ?? this.session?.resolvedModel;
  }

  /** Pause the stall watchdog (need_decision). Nested with tool execution. */
  pauseStall(): void {
    this.decisionPaused = true;
    this.clearStall();
  }

  resumeStall(): void {
    this.decisionPaused = false;
    this.lastEvent = this.clock.now();
    if (this.status_ === "running" && this.toolDepth === 0) this.armStall(this.generation);
  }

  conversation() {
    return this.session?.getConversation() ?? [];
  }

  /** Launch generation 1. Resolves once the prompt is issued (not completed). */
  async launch(): Promise<void> {
    await this.beginGeneration(this.req.prompt, true);
  }

  async steer(message: string): Promise<void> {
    if (this.status_ !== "running" || !this.session) {
      throw new Error(`subagent ${this.req.childId} is not running (status: ${this.status_})`);
    }
    if (this.retiredGen !== null) {
      // The previous generation was aborted; delivery would be undefined.
      throw new Error(`subagent ${this.req.childId} is restarting after a stall; retry shortly`);
    }
    await this.session.steer(message);
  }

  async followUp(message: string): Promise<void> {
    if (this.status_ !== "running" || !this.session) {
      throw new Error(`subagent ${this.req.childId} is not running (status: ${this.status_})`);
    }
    if (this.retiredGen !== null) {
      throw new Error(`subagent ${this.req.childId} is restarting after a stall; retry shortly`);
    }
    await this.session.followUp(message);
  }

  async resume(message: string): Promise<void> {
    if (this.status_ === "running" || this.status_ === "pending") {
      throw new Error(
        `subagent ${this.req.childId} is still ${this.status_}; use steer for a running subagent`,
      );
    }
    if (this.disposed) {
      throw new Error(`subagent ${this.req.childId} has been disposed`);
    }
    if (!this.session) {
      throw new Error(`subagent ${this.req.childId} has no session to resume`);
    }
    // A new user turn gets a fresh stall budget and a fresh timeout budget.
    this.stallAttempts = 0;
    this.runStartedAt = this.clock.now();
    // Swap in the new generation's result promise synchronously so that
    // registry.getResult() observes it before/while admission runs.
    this.resultPromise = new Promise((resolve) => {
      this.resolveResult = resolve;
    });
    await this.beginGeneration(message, false);
  }

  async interrupt(): Promise<void> {
    if (this.status_ !== "running" && this.status_ !== "pending") return;
    this.settle(this.generation, {
      status: "interrupted",
      text: this.partialText(),
      durationMs: this.now() - this.startedAt,
    });
    try {
      await this.session?.abort();
    } catch {
      // abort is best-effort; the result is already settled
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    if (this.unsubscribe) {
      try {
        this.unsubscribe();
      } catch {
        // ignore
      }
      this.unsubscribe = null;
    }
    const session = this.session;
    this.session = null;
    if (session) {
      try {
        session.dispose();
      } catch {
        // ignore
      }
    }
    // Never leave result waiters hanging.
    this.settle(this.generation, { status: "interrupted", text: "", error: "disposed", durationMs: 0 });
  }

  // -------------------------------------------------------------------------
  // Generation machinery
  // -------------------------------------------------------------------------

  /**
   * Start a generation. `reuseSlot` is used by stall retries: the admission
   * slot acquired by the stalled generation is still held (no settle happened),
   * so admission is not re-run and the slot is not double-counted.
   */
  private async beginGeneration(prompt: string, first: boolean, reuseSlot = false): Promise<void> {
    const gen = ++this.generation;
    this.retiredGen = null;
    this.clearRetryTimer();
    this.timerScope?.dispose();
    this.timerScope = new TimerScope(this.clock);
    this.settledFlag = false;
    this.status_ = "pending";
    this.startedAt = this.clock.now();
    this.lastEvent = this.startedAt;
    // A tool_execution_end from the previous generation may have been dropped
    // after settle. Don't carry that depth (or a pending decision) into this one.
    this.toolDepth = 0;
    this.decisionPaused = false;

    if (this.acquire && !reuseSlot) {
      try {
        this.releaseSlot = await this.acquire(this.req);
      } catch (err) {
        // Admission denied (e.g. fail_fast cancellation while queued).
        this.settle(gen, {
          status: "interrupted",
          text: "",
          error: errorMessage(err),
          durationMs: this.now() - this.startedAt,
        });
        return;
      }
    }
    if (this.disposed || this.isSettled(gen)) {
      this.release();
      return;
    }
    this.status_ = "running";

    if (first) {
      try {
        this.session = await this.createSession(this.req);
        this.resolvedModel_ = this.session.resolvedModel;
      } catch (err) {
        this.settle(gen, {
          status: "failed",
          text: "",
          error: errorMessage(err),
          durationMs: this.now() - this.startedAt,
        });
        return;
      }
      if (this.disposed || this.isSettled(gen)) {
        this.release();
        return;
      }
      this.unsubscribe = this.session.subscribe((event) => {
        if (event.type === "message_end" || event.type === "tool_execution_end" || event.type === "agent_end") {
          this.notifyActivity();
        }
        // Track depth even after settle. A late tool_execution_end must not
        // leak into the next resume, and must not rearm a stale generation.
        if (event.type === "tool_execution_start") {
          this.toolDepth++;
          if (this.status_ === "running") this.clearStall();
          return;
        }
        if (event.type === "tool_execution_end") {
          this.toolDepth = Math.max(0, this.toolDepth - 1);
          this.lastEvent = this.now();
          if (this.status_ === "running" && this.toolDepth === 0 && !this.decisionPaused) {
            this.armStall(this.generation);
          }
          return;
        }
        if (this.status_ !== "running") return;
        this.lastEvent = this.now();
        if (this.toolDepth === 0 && !this.decisionPaused) this.armStall(this.generation);
      });
    }

    const session = this.session;
    if (!session) {
      this.settle(gen, {
        status: "failed",
        text: "",
        error: "no session available",
        durationMs: this.now() - this.startedAt,
      });
      return;
    }

    // The timeout budget starts only after admission and session creation:
    // time spent queued for an admission slot is not the child's budget.
    if (!reuseSlot) this.turnBudgetStart = this.now();
    this.armTimeout(gen);
    // A stall can spend the whole timeout budget before this generation
    // starts; armTimeout settles in that case and prompting must not proceed.
    if (this.isSettled(gen)) return;
    this.armStall(gen);
    // Tell the child which model it is — otherwise only the parent/fleet knows.
    const prompted =
      first && session.resolvedModel
        ? `You are running as model ${session.resolvedModel}.\n\n${prompt}`
        : prompt;
    // Floating: prompt() resolves when the whole run settles (pi semantics).
    session.prompt(prompted).then(
      () => {
        void this.finishGeneration(gen);
      },
      (err) => {
        if (!this.isCurrent(gen)) return;
        this.settle(gen, {
          status: "failed",
          text: this.partialText(),
          error: errorMessage(err),
          durationMs: this.now() - this.startedAt,
        });
      },
    );
  }

  private async finishGeneration(gen: number): Promise<void> {
    if (!this.isCurrent(gen)) return;
    const session = this.session;
    if (session) {
      try {
        await session.waitForIdle();
      } catch {
        // A waitForIdle failure after a resolved prompt is not actionable;
        // fall through and report whatever text we have.
      }
    }
    if (!this.isCurrent(gen)) return;
    const failure = session?.getLastAssistantFailure?.();
    if (failure) {
      this.settle(gen, {
        status: "failed",
        text: this.partialText(),
        error: failure.errorMessage?.trim() || `Model stopped with ${failure.stopReason}`,
        endReason: "model-error",
        durationMs: this.now() - this.startedAt,
      });
      return;
    }
    this.settle(gen, {
      status: "completed",
      text: this.partialText(),
      durationMs: this.now() - this.startedAt,
    });
  }

  private partialText(): string {
    return this.session?.getLastAssistantText() || "(no output)";
  }

  private now(): number {
    return this.clock.now();
  }

  private isSettled(gen: number): boolean {
    return gen !== this.generation || this.settledFlag;
  }

  private isCurrent(gen: number): boolean {
    // A stall-retired generation is neither settled nor current: its aborted
    // prompt resolves shortly after detection and must not be reported as
    // the child's completion while the retry is still pending.
    return gen === this.generation && !this.settledFlag && !this.disposed && gen !== this.retiredGen;
  }

  private settle(gen: number, result: ChildResult): void {
    if (gen !== this.generation || this.settledFlag) return;
    this.settledFlag = true;
    this.clearTimers();
    // Generations run: 1 + resumes + stall retries. Forensics for the
    // incident class this exists for (a stalled child that needed retries).
    if (result.attempts === undefined) result.attempts = this.generation;
    // durationMs covers the whole user turn (launch/resume -> settle),
    // including time lost to stalls and retry delays. dispose keeps its 0.
    if (result.error !== "disposed") result.durationMs = this.now() - this.runStartedAt;
    if (result.stalls === undefined && this.stallAttempts > 0) {
      result.stalls = this.stallAttempts;
    }
    // Surface non-fatal setup caveats (e.g. agent-def model fallback) once.
    if (result.warning === undefined && this.session?.warning) {
      result.warning = this.session.warning;
    }
    this.status_ = result.status;
    this.release();
    this.notifyActivity();
    this.resolveResult(result);
  }

  private notifyActivity(): void {
    try {
      this.onActivity?.(this.req.childId);
    } catch {
      // persistence observers must not break the child lifecycle
    }
  }

  private release(): void {
    const release = this.releaseSlot;
    this.releaseSlot = null;
    if (release) {
      try {
        release();
      } catch {
        // ignore
      }
    }
  }

  private armTimeout(gen: number): void {
    if (this.timeoutTimer !== null) {
      this.timerScope?.clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (!(this.req.timeoutMs > 0)) return;
    // The timeout is a budget for the whole user turn: a stall retry arms
    // only what the stalled generation did not already consume. The budget
    // clock starts after admission (turnBudgetStart), not at launch.
    const remaining = this.req.timeoutMs - (this.now() - this.turnBudgetStart);
    if (remaining <= 0) {
      this.settle(gen, {
        status: "interrupted",
        text: this.partialText(),
        error: "timeout",
        durationMs: this.now() - this.runStartedAt,
      });
      return;
    }
    this.timeoutTimer = this.timerScope?.setTimeout(() => {
      this.timeoutTimer = null;
      // Deliberately NOT isCurrent(): a timeout landing during a stall's
      // retry delay must still fire — the retry has not started a new
      // generation, and the budget is spent.
      if (this.settledFlag || this.disposed || gen !== this.generation) return;
      this.settle(gen, {
        status: "interrupted",
        text: this.partialText(),
        error: "timeout",
        durationMs: this.now() - this.runStartedAt,
      });
      void this.session?.abort().catch(() => {});
    }, remaining) ?? null;
  }

  private armStall(gen: number): void {
    if (this.stallTimer !== null) {
      this.timerScope?.clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    if (!(this.stallMs > 0)) return;
    this.stallTimer = this.timerScope?.setTimeout(() => {
      this.stallTimer = null;
      if (!this.isCurrent(gen)) return;
      this.handleStall(gen);
    }, this.stallMs) ?? null;
  }

  /**
   * Stall detection. Abort the hung generation (frees a silently dropped
   * provider stream), then either settle failed (retries exhausted) or
   * schedule an auto-resume on the same session after `stallRetryDelayMs`.
   * The admission slot and result promise survive; the transcript is kept.
   */
  private handleStall(gen: number): void {
    this.stallAttempts++;
    // Persist whatever the stalled generation produced before it went quiet.
    this.notifyActivity();
    try {
      this.onStall?.(this.req.childId, this.stallAttempts);
    } catch {
      // stall observers must not break the retry machinery
    }
    this.retiredGen = gen;
    // Kick the abort off now so the unwind overlaps the retry delay; the
    // retry timer awaits it (bounded) before re-prompting. Real pi rejects
    // prompt() while the aborted run is still active.
    this.abortPromise = this.session ? this.session.abort().catch(() => {}) : null;
    if (this.stallAttempts > this.stallRetries) {
      this.settle(gen, {
        status: "failed",
        text: this.partialText(),
        error: "stalled",
        durationMs: this.now() - this.runStartedAt,
      });
      return;
    }
    const scope = this.timerScope;
    if (!scope) return;
    const id = scope.setTimeout(() => {
      this.retryTimer = null;
      // interrupt()/dispose() during the delay settles this generation. The
      // retiredGen exclusion in isCurrent() must NOT apply here: retrying the
      // retired generation is precisely this timer's job.
      if (this.settledFlag || this.disposed || gen !== this.generation) return;
      void this.retryAfterAbort(gen);
    }, this.stallRetryDelayMs);
    this.retryTimer = { scope, id };
  }

  /**
   * Resume after a stall: wait for the abort to finish (bounded by stallMs),
   * then re-prompt the same session. An abort that never completes means the
   * stream ignored it — the session is dead, so the retry is skipped and the
   * run settles failed (stalled).
   */
  private async retryAfterAbort(gen: number): Promise<void> {
    if (this.settledFlag || this.disposed || gen !== this.generation) return;
    const abort = this.abortPromise;
    this.abortPromise = null;
    if (abort) {
      let boundTimer: ClockTimer | null = null;
      const bound = new Promise<"timeout">((resolve) => {
        const scope = this.timerScope;
        if (!scope) {
          resolve("timeout");
          return;
        }
        boundTimer = scope.setTimeout(() => resolve("timeout"), this.stallMs);
      });
      // Note: if interrupt()/dispose() lands during this race, clearTimers
      // disposes the scope and the bound never fires; a hung abort then
      // leaves this async fn pending forever. Harmless — the result is
      // already settled and the closure holds no resources — but not
      // garbage-collectable until the abort settles.
      const outcome = await Promise.race([abort.then(() => "aborted" as const), bound]);
      if (boundTimer !== null) this.timerScope?.clearTimeout(boundTimer);
      if (outcome === "timeout") {
        this.settle(gen, {
          status: "failed",
          text: this.partialText(),
          error: "stalled",
          durationMs: this.now() - this.runStartedAt,
        });
        return;
      }
    }
    if (this.settledFlag || this.disposed || gen !== this.generation) return;
    await this.beginGeneration(stallRetryPrompt(this.stallMs), false, true);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      this.retryTimer.scope.clearTimeout(this.retryTimer.id);
      this.retryTimer = null;
    }
  }

  private clearStall(): void {
    if (this.stallTimer !== null) {
      this.timerScope?.clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private clearTimers(): void {
    if (this.timeoutTimer !== null) {
      this.timerScope?.clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    this.clearStall();
    this.clearRetryTimer();
    this.timerScope?.dispose();
    this.timerScope = null;
  }
}
