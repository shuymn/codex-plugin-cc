import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { ensureReaped, runCodex } from "../plugins/codex/scripts/lib/codex-exec.ts";
import { ReapError, spawnCodexGroup } from "../plugins/codex/scripts/lib/process-group.ts";
import { makeFakeEnv, makeTempDir, waitForFile, waitUntilGone } from "./helpers.ts";

// Runs the fake codex in-process, so the kill function can be swapped for one
// that fails the way the OS can (EPERM).
function useFake(scenario: string): { ready: string; restore: () => void } {
  const fake = makeFakeEnv({ scenario });
  const ready = path.join(makeTempDir(), "ready");
  const saved = { ...process.env };
  Object.assign(process.env, {
    PATH: fake.env.PATH,
    FAKE_CODEX_LOG: fake.env.FAKE_CODEX_LOG,
    FAKE_CODEX_SCENARIO: scenario,
    FAKE_CODEX_READY_FILE: ready,
  });
  return {
    ready,
    restore: () => {
      process.env = saved;
    },
  };
}

function failingKill(code: string) {
  return (pid: number, signal: NodeJS.Signals | 0): void => {
    void pid;
    void signal;
    throw Object.assign(new Error(`kill failed: ${code}`), { code });
  };
}

const EXEC_ARGS = ["exec", "-s", "read-only", "-"];

test("a group that cannot be signaled is reported as not reaped, within the bound", { timeout: 30_000 }, async () => {
  const { ready, restore } = useFake("slow");
  try {
    const group = spawnCodexGroup(EXEC_ARGS, {
      cwd: makeTempDir(),
      interruptGraceMs: 100,
      terminateGraceMs: 100,
      reapGraceMs: 300,
      kill: failingKill("EPERM"),
    });
    group.child.stdin.end("go");
    const pid = Number(await waitForFile(ready));
    const started = Date.now();
    group.stop();
    const exit = await group.exited;
    const elapsed = Date.now() - started;
    // SIGKILL at 200 ms, then 300 ms of grace; the child never exits here.
    assert.ok(elapsed < 2_000, `took ${elapsed} ms`);
    assert.match(exit.reapError ?? "", /EPERM/);
    process.kill(pid, "SIGKILL");
    assert.ok(await waitUntilGone(pid));
  } finally {
    restore();
  }
});

test("a run whose group outlives codex is not a success", { timeout: 30_000 }, async () => {
  const { restore } = useFake("ok");
  try {
    let probes = 0;
    const result = await runCodex(EXEC_ARGS, {
      cwd: makeTempDir(),
      stdin: "go",
      interruptGraceMs: 100,
      terminateGraceMs: 100,
      reapGraceMs: 300,
      // The real codex exits; the group still looks alive and cannot be signaled.
      kill: (pid, signal) => {
        void pid;
        if (signal === 0) {
          probes += 1;
          return;
        }
        throw Object.assign(new Error("kill failed: EPERM"), { code: "EPERM" });
      },
    });
    assert.equal(result.exitCode, 0);
    assert.ok(probes > 0);
    assert.ok(result.reapError);
    assert.throws(() => ensureReaped(result), ReapError);
  } finally {
    restore();
  }
});

test("ESRCH from a stop signal means the group is already gone", { timeout: 30_000 }, async () => {
  const { restore } = useFake("ok");
  try {
    const result = await runCodex(EXEC_ARGS, {
      cwd: makeTempDir(),
      stdin: "go",
      reapGraceMs: 300,
      kill: failingKill("ESRCH"),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.reapError, null);
    assert.doesNotThrow(() => ensureReaped(result));
  } finally {
    restore();
  }
});
