/**
 * EffectChildRunner (design doc §4.6): ChildRunner with Effect-managed
 * generation state, completion, timeout, stall, and resource scopes. The pi
 * session adapter remains behind the injected CreateSessionFn boundary.
 *
 * Zero pi dependency — the real session factory lives in pi-runtime.ts and
 * tests inject fakes.
 *
 * Lifecycle per child ("generation" = one prompt..settle cycle; resume()
 * starts a new generation on the same session):
 * - a per-generation admission slot is acquired via the optional `acquire`
 *   hook (the registry uses it for the global concurrency cap);
 * - `timeoutMs` is a hard timeout: abort -> result {status:"interrupted", error:"timeout"};
 * - a stall watchdog aborts the child after `stallMs` (default 5min) without
 *   any session event -> {status:"failed", error:"stalled"};
 * - session/prompt exceptions -> {status:"failed", error}.
 *
 * Note on pi semantics: AgentSession.prompt() resolves only after the whole
 * agent run settles, so the prompt promise itself is the completion signal;
 * waitForIdle() is awaited afterwards as belt-and-braces for queued
 * steer/followUp processing.
 */
import { Clock, Deferred, Duration, Effect, Exit, Fiber, Ref, Scope } from "./effect-imports";
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

export interface EffectChildRunnerOptions {
  createSession: CreateSessionFn;
  /** Stall watchdog timeout (ms). Default 10 minutes. */
  stallMs?: number;
  /** Optional Effect clock (e.g. TestClock); omitted means the live clock. */
  clock?: Clock.Clock;
  /**
   * Per-generation admission hook. Awaited before each (re)start; the
   * resolved releaser is called when the generation settles. Rejecting
   * cancels the generation as {status:"interrupted", error}.
   */
  acquire?: (req: ChildRunRequest) => Promise<() => void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class EffectChildRunner implements ChildRunner {
  private readonly opts: EffectChildRunnerOptions;

  constructor(opts: EffectChildRunnerOptions) {
    this.opts = opts;
  }

  async start(req: ChildRunRequest): Promise<DisposableChildHandle> {
    const handle = new EffectChildHandle(req, this.opts);
    await handle.launch();
    return handle;
  }
}

class EffectChildHandle implements DisposableChildHandle {
  private readonly req: ChildRunRequest;
  private readonly createSession: CreateSessionFn;
  private readonly stallMs: number;
  private readonly clock?: Clock.Clock;
  private readonly acquire?: (req: ChildRunRequest) => Promise<() => void>;

  private session: ChildSessionAdapter | null = null;
  private resolvedModel_: string | undefined;
  private unsubscribe: (() => void) | null = null;
  private status_: ChildStatus = "pending";
  private lastEvent: number;
  private startedAt: number;
  private generation = 0;
  private settled = Effect.runSync(Ref.make(false));
  private resultDeferred = Effect.runSync(Deferred.make<ChildResult>());
  private generationScope: Scope.CloseableScope | null = null;
  private timerFibers = new Set<Fiber.RuntimeFiber<void, never>>();
  private timeoutFiber: Fiber.RuntimeFiber<void, never> | null = null;
  private stallFiber: Fiber.RuntimeFiber<void, never> | null = null;
  private releaseSlot: (() => void) | null = null;
  private disposed = false;
  /** Nested tool_execution_start/end. Stall stays paused while > 0. */
  private toolDepth = 0;
  /** contact_supervisor need_decision. Stall stays paused while true. */
  private decisionPaused = false;

  constructor(req: ChildRunRequest, opts: EffectChildRunnerOptions) {
    this.req = req;
    this.createSession = opts.createSession;
    this.stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
    this.clock = opts.clock;
    this.acquire = opts.acquire;
    this.startedAt = this.now();
    this.lastEvent = this.startedAt;
  }

  get childId(): string {
    return this.req.childId;
  }

  /** Current generation's result promise (see Appendix B note on resume). */
  get result(): Promise<ChildResult> {
    return this.runPromise(Deferred.await(this.resultDeferred));
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
    this.lastEvent = this.now();
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
    await this.session.steer(message);
  }

  async followUp(message: string): Promise<void> {
    if (this.status_ !== "running" || !this.session) {
      throw new Error(`subagent ${this.req.childId} is not running (status: ${this.status_})`);
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
    // Replace the completed generation's deferred before admission so callers
    // observe the new result while this generation is starting.
    this.resultDeferred = Effect.runSync(Deferred.make<ChildResult>());
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

  private async beginGeneration(prompt: string, first: boolean): Promise<void> {
    const gen = ++this.generation;
    this.settled = Effect.runSync(Ref.make(false));
    this.generationScope = this.sync(Scope.make());
    this.timerFibers = new Set();
    this.sync(
      Scope.addFinalizer(
        this.generationScope,
        Effect.suspend(() =>
          Effect.forEach(
            Array.from(this.timerFibers),
            (fiber) => Fiber.interruptFork(fiber),
            { discard: true },
          ),
        ),
      ),
    );
    this.status_ = "pending";
    this.startedAt = this.now();
    this.lastEvent = this.startedAt;
    // A tool_execution_end from the previous generation may have been dropped
    // after settle. Don't carry that depth (or a pending decision) into this one.
    this.toolDepth = 0;
    this.decisionPaused = false;

    if (this.acquire) {
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

    this.armTimeout(gen);
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
    this.settle(gen, {
      status: "completed",
      text: this.partialText(),
      durationMs: this.now() - this.startedAt,
    });
  }

  private partialText(): string {
    return this.session?.getLastAssistantText() || "(no output)";
  }

  private isSettled(gen: number): boolean {
    return gen !== this.generation || this.sync(Ref.get(this.settled));
  }

  private isCurrent(gen: number): boolean {
    return gen === this.generation && !this.sync(Ref.get(this.settled)) && !this.disposed;
  }

  private settle(gen: number, result: ChildResult): void {
    if (gen !== this.generation || this.sync(Ref.get(this.settled))) return;
    if (!this.sync(Deferred.succeed(this.resultDeferred, result))) return;
    this.sync(Ref.set(this.settled, true));
    this.clearTimers();
    // Surface non-fatal setup caveats (e.g. agent-def model fallback) once.
    if (result.warning === undefined && this.session?.warning) {
      result.warning = this.session.warning;
    }
    this.status_ = result.status;
    this.release();
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
    this.cancelFiber(this.timeoutFiber);
    this.timeoutFiber = null;
    if (!(this.req.timeoutMs > 0)) return;
    this.timeoutFiber = this.schedule(this.req.timeoutMs, () => {
      this.timeoutFiber = null;
      if (!this.isCurrent(gen)) return;
      this.settle(gen, {
        status: "interrupted",
        text: this.partialText(),
        error: "timeout",
        durationMs: this.now() - this.startedAt,
      });
      void this.session?.abort().catch(() => {});
    });
  }

  private armStall(gen: number): void {
    this.clearStall();
    if (!(this.stallMs > 0)) return;
    this.stallFiber = this.schedule(this.stallMs, () => {
      this.stallFiber = null;
      if (!this.isCurrent(gen)) return;
      this.settle(gen, {
        status: "failed",
        text: this.partialText(),
        error: "stalled",
        durationMs: this.now() - this.startedAt,
      });
      void this.session?.abort().catch(() => {});
    });
  }

  private clearStall(): void {
    this.cancelFiber(this.stallFiber);
    this.stallFiber = null;
  }

  private clearTimers(): void {
    this.cancelFiber(this.timeoutFiber);
    this.timeoutFiber = null;
    this.clearStall();
    const scope = this.generationScope;
    this.generationScope = null;
    if (scope) void this.runPromise(Scope.close(scope, Exit.succeed(undefined))).catch(() => {});
  }

  private schedule(ms: number, callback: () => void): Fiber.RuntimeFiber<void, never> {
    const scope = this.generationScope;
    if (!scope) throw new Error("cannot schedule a child timer without a generation scope");
    let fiber: Fiber.RuntimeFiber<void, never>;
    const timer = Effect.tap(Clock.sleep(Duration.millis(ms)), () =>
      Effect.sync(() =>
        queueMicrotask(() => {
          this.timerFibers.delete(fiber);
          callback();
        }),
      ),
    );
    const clockedTimer = this.clock ? Effect.withClock(timer, this.clock) : timer;
    fiber = this.sync(Effect.forkDaemon(clockedTimer));
    this.timerFibers.add(fiber);
    return fiber;
  }

  private cancelFiber(fiber: Fiber.RuntimeFiber<void, never> | null): void {
    if (!fiber) return;
    this.timerFibers.delete(fiber);
    this.sync(Fiber.interruptFork(fiber));
  }

  private now(): number {
    return this.sync(Clock.currentTimeMillis);
  }

  private sync<A, E>(effect: Effect.Effect<A, E>): A {
    const program = this.clock ? Effect.withClock(effect, this.clock) : effect;
    return Effect.runSync(program);
  }

  private runPromise<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
    const program = this.clock ? Effect.withClock(effect, this.clock) : effect;
    return Effect.runPromise(program);
  }
}
