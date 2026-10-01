/** Test-only fresh Node runner with an owned process group and bounded cleanup. */
import { spawn } from "node:child_process";

export function startFreshNode(source: string, opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env: opts.env, detached: true });
  const completed = new Promise<void>((resolve, reject) => {
    let output = "";
    let timedOut = false;
    let finished = false;
    let cleanupNote = "";
    let watchdog: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let cleanupGuard: NodeJS.Timeout | undefined;
    const collect = (chunk: Buffer) => { output += chunk; };
    const terminate = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupNote += `; ${signal}: ${(error as Error).message}`;
      }
    };
    const stopStreams = () => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const failure = (reason: string) => new Error(`${reason} (pid=${child.pid}, code=${child.exitCode}, signal=${child.signalCode})${cleanupNote}: ${output}`);
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(watchdog);
      clearTimeout(escalation);
      clearTimeout(cleanupGuard);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      child.stdout.removeListener("data", collect);
      child.stderr.removeListener("data", collect);
      if (error) reject(error); else resolve();
    };
    const onError = (error: Error) => {
      terminate("SIGKILL");
      stopStreams();
      child.unref();
      finish(failure(`fresh Node failed: ${error.message}`));
    };
    const onClose = (code: number | null) => {
      finish(timedOut ? failure(`fresh Node timed out after ${timeoutMs}ms`)
        : code === 0 ? undefined : failure(`fresh Node exited ${code}`));
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", onError);
    child.once("close", onClose);
    watchdog = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      escalation = setTimeout(() => {
        terminate("SIGKILL");
        // Prefer real close/reaping, but inherited stdio must not hang the guard.
        cleanupGuard = setTimeout(() => {
          stopStreams();
          child.unref();
          finish(failure(`fresh Node timed out after ${timeoutMs}ms; cleanup close guard expired`));
        }, 1000);
      }, 1000);
    }, timeoutMs);
  });
  return { child, completed };
}
