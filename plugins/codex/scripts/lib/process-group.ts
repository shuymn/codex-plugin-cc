import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

// Runs `codex` in its own process group and stops the whole group in stages.
//
// The npm build of the CLI is a Node launcher that runs the native binary as
// its child, and the launcher forwards only the first signal it receives. So
// every stop signal goes to the group (the launcher and everything under it):
// SIGINT first, which exec turns into a graceful turn interrupt, then SIGTERM,
// then SIGKILL. The result settles only once the group is gone and the output
// streams are closed, so callers can delete their temporary files safely.

export const INTERRUPT_GRACE_MS = 10_000;
export const TERMINATE_GRACE_MS = 5_000;
// How long after SIGKILL the group still gets to disappear before the
// adapter stops waiting and reports that it could not reap it.
export const REAP_GRACE_MS = 2_000;
// Bounds the wait for stdout and stderr to close after the group is gone, in
// case a process that left the group still holds them open.
const STREAM_CLOSE_GRACE_MS = 2_000;
const POLL_MS = 50;

export class CodexNotFoundError extends Error {
  override name = "CodexNotFoundError";
}

// Thrown when the adapter received a signal and stopped the group; the
// process should exit with 128 + n.
export class InterruptedError extends Error {
  override name = "InterruptedError";
  signal: NodeJS.Signals;

  constructor(signal: NodeJS.Signals) {
    super(`interrupted by ${signal}`);
    this.signal = signal;
  }
}

// Codex processes may still be running: the group could not be signaled, or
// did not disappear in time after SIGKILL.
export class ReapError extends Error {
  override name = "ReapError";
}

export type KillFunction = (pid: number, signal: NodeJS.Signals | 0) => void;

export type StopTiming = {
  interruptGraceMs?: number;
  terminateGraceMs?: number;
  reapGraceMs?: number;
  // For tests: replaces process.kill.
  kill?: KillFunction;
};

export type GroupOptions = StopTiming & {
  cwd: string;
  // Stops the group after this long and reports timedOut.
  timeoutMs?: number;
  // Runs first when stopping, e.g. to close stdin for a graceful shutdown.
  onStop?: () => void;
};

export type GroupExit = {
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  // The signal the adapter itself received while the group ran.
  receivedSignal: NodeJS.Signals | null;
  timedOut: boolean;
  // Set when the group could not be reaped; the run is then not a success.
  reapError: string | null;
};

export type CodexGroup = {
  child: ChildProcessWithoutNullStreams;
  stop: () => void;
  exited: Promise<GroupExit>;
};

// Copies the timing fields that are set, for passing options along.
export function pickStopTiming(options: StopTiming): StopTiming {
  const timing: StopTiming = {};
  if (options.interruptGraceMs !== undefined) {
    timing.interruptGraceMs = options.interruptGraceMs;
  }
  if (options.terminateGraceMs !== undefined) {
    timing.terminateGraceMs = options.terminateGraceMs;
  }
  if (options.reapGraceMs !== undefined) {
    timing.reapGraceMs = options.reapGraceMs;
  }
  if (options.kill !== undefined) {
    timing.kill = options.kill;
  }
  return timing;
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error ? String(error.code) : "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function spawnCodexGroup(args: readonly string[], options: GroupOptions): CodexGroup {
  const child = spawn("codex", args, {
    cwd: options.cwd,
    shell: false,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const kill: KillFunction = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const interruptGraceMs = options.interruptGraceMs ?? INTERRUPT_GRACE_MS;
  const terminateGraceMs = options.terminateGraceMs ?? TERMINATE_GRACE_MS;
  const reapGraceMs = options.reapGraceMs ?? REAP_GRACE_MS;
  const timers: NodeJS.Timeout[] = [];
  let receivedSignal: NodeJS.Signals | null = null;
  let timedOut = false;
  let stopping = false;
  let reapError: string | null = null;
  let giveUp: (() => void) | null = null;
  let giveUpTimer: NodeJS.Timeout | undefined;
  // Set once the group is confirmed gone; only the output streams remain.
  let groupGone = false;

  // ESRCH means the group is already gone; any other failure (EPERM, ...)
  // means it may still be running and is kept as a reap failure.
  const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
    if (child.pid === undefined) {
      return false;
    }
    try {
      kill(-child.pid, signal);
      return true;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ESRCH") {
        return false;
      }
      reapError ??= `could not signal the Codex process group ${child.pid} (${code}); Codex processes may still be running.`;
      return true;
    }
  };

  const stop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    try {
      options.onStop?.();
    } catch {
      // Stopping must go on even if the graceful step fails.
    }
    signalGroup("SIGINT");
    timers.push(
      setTimeout(() => signalGroup("SIGTERM"), interruptGraceMs),
      setTimeout(() => signalGroup("SIGKILL"), interruptGraceMs + terminateGraceMs),
    );
    // The bound does not depend on the child's exit event: once SIGKILL has
    // had reapGraceMs to work, the stop ladder gives up waiting for the group.
    giveUpTimer = setTimeout(() => giveUp?.(), interruptGraceMs + terminateGraceMs + reapGraceMs);
    timers.push(giveUpTimer);
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    receivedSignal ??= signal;
    stop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  if (options.timeoutMs !== undefined) {
    timers.push(
      setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs),
    );
  }

  const cleanup = (): void => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    for (const timer of timers) {
      clearTimeout(timer);
    }
  };

  let streamsClosed = false;
  child.on("close", () => {
    streamsClosed = true;
  });

  const exited = new Promise<GroupExit>((resolve, reject) => {
    let settled = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (!streamsClosed) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
      if (reapError !== null) {
        // Do not let a process we failed to reap keep the adapter alive.
        child.stdin.destroy();
        child.unref();
      }
      resolve({ exitCode, exitSignal, receivedSignal, timedOut, reapError });
    };
    giveUp = () => {
      // A group that is already gone was reaped, even if a process that left
      // it still holds the output open; the stream wait has its own bound.
      if (groupGone || !signalGroup(0)) {
        return;
      }
      reapError ??= `the Codex process group ${child.pid ?? "?"} did not exit after SIGKILL; Codex processes may still be running.`;
      finish();
    };

    child.on("error", (error) => {
      if (settled || child.pid !== undefined) {
        return;
      }
      settled = true;
      cleanup();
      reject(
        error instanceof Error && errorCode(error) === "ENOENT"
          ? new CodexNotFoundError("codex was not found on PATH.")
          : error,
      );
    });
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      void (async () => {
        // Anything left in the group (the launcher's child, or processes
        // Codex started) is stopped too; giveUp bounds this wait.
        for (;;) {
          if (settled) {
            break;
          }
          if (!signalGroup(0)) {
            groupGone = true;
            clearTimeout(giveUpTimer);
            break;
          }
          stop();
          await sleep(POLL_MS);
        }
        if (!settled && !streamsClosed) {
          let streamTimer: NodeJS.Timeout | undefined;
          await new Promise<void>((resolveClose) => {
            streamTimer = setTimeout(resolveClose, STREAM_CLOSE_GRACE_MS);
            child.once("close", () => resolveClose());
          });
          clearTimeout(streamTimer);
        }
        finish();
      })();
    });
  });

  child.stdin.on("error", () => {});
  return { child, stop, exited };
}
