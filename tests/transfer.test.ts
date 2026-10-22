import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { importClaudeSession, TransferError } from "../plugins/codex/scripts/lib/transfer.ts";
import {
  exitCodeOf,
  firstLine,
  makeFakeEnv,
  makeTempDir,
  runAdapter,
  spawnAdapter,
  waitForFile,
  waitUntilGone,
} from "./helpers.ts";

// The smallest Claude transcript the real importer accepts: a record with the
// session's cwd and a conversation (codex-rs external-agent-migration).
function transcriptLines(cwd: string): string {
  return [
    { type: "user", cwd, timestamp: "2026-06-03T12:00:00Z", message: { role: "user", content: "Fix the build." } },
    {
      type: "assistant",
      cwd,
      timestamp: "2026-06-03T12:00:05Z",
      message: { role: "assistant", content: [{ type: "text", text: "Fixed it." }] },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");
}

function setup(scenario = "ok") {
  const fake = makeFakeEnv({ scenario });
  const projectDir = path.join(fake.home, ".claude", "projects", "-repo");
  fs.mkdirSync(projectDir, { recursive: true });
  const transcript = path.join(projectDir, "session-1.jsonl");
  const cwd = makeTempDir();
  fs.writeFileSync(transcript, `${transcriptLines(cwd)}\n`);
  return { fake, transcript, cwd };
}

test("transfer imports the current transcript and prints the resume command", () => {
  const { fake, transcript, cwd } = setup();
  fake.env.CODEX_COMPANION_TRANSCRIPT_PATH = transcript;
  const result = runAdapter("transfer", "", { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 3);
  const threadId = /^Codex session ID: (\S+)$/.exec(lines[1] ?? "")?.[1];
  assert.ok(threadId);
  assert.equal(lines[2], `Resume in Codex: codex resume ${threadId}`);

  const calls = fake.readLog();
  const rpcs = calls.flatMap((call) => (call.rpc ? [call.rpc] : []));
  assert.deepEqual(
    rpcs.filter((rpc) => rpc.method).map((rpc) => rpc.method),
    ["initialize", "initialized", "externalAgentConfig/import"],
  );
  // The server-initiated request is refused with method-not-found.
  assert.ok(rpcs.some((rpc) => rpc.id === "server-1" && rpc.error?.code === -32601));
  // It waited past the completion for another import until its own arrived,
  // then closed stdin and the app-server exited before the adapter did.
  const events = calls.flatMap((call) =>
    call.completed ? [`completed:${call.completed}`] : call.appServerClosed ? ["closed"] : [],
  );
  assert.deepEqual(events, ["completed:other", "completed:import-1", "closed"]);
});

test("transfer fails when the transcript has nothing the importer accepts", () => {
  const { fake, transcript, cwd } = setup();
  fs.writeFileSync(transcript, '{"type":"user","message":{"content":"no cwd"}}\n');
  const result = runAdapter("transfer", `--source ${transcript}`, { env: fake.env, cwd });
  assert.equal(result.status, 1);
  assert.match(firstLine(result.stderr), /did not record an imported thread/);
});

test("SIGTERM during transfer stops the app-server and exits 143", { timeout: 60_000 }, async () => {
  const { fake, transcript, cwd } = setup("transfer-hang");
  const ready = path.join(makeTempDir(), "ready");
  const child = spawnAdapter("transfer", `--source ${transcript}`, {
    env: { ...fake.env, FAKE_CODEX_READY_FILE: ready },
    cwd,
  });
  const exited = exitCodeOf(child);
  const serverPid = Number(await waitForFile(ready));
  child.kill("SIGTERM");
  assert.equal(await exited, 143);
  assert.ok(await waitUntilGone(serverPid), "the app-server is still running");
});

// In-process runs of the client, with short deadlines.
async function importInProcess(scenario: string, timing: { timeoutMs: number; graceMs: number }) {
  const { fake, transcript, cwd } = setup(scenario);
  const ready = path.join(makeTempDir(), "ready");
  const saved = { ...process.env };
  Object.assign(process.env, {
    PATH: fake.env.PATH,
    CODEX_HOME: fake.env.CODEX_HOME,
    FAKE_CODEX_LOG: fake.env.FAKE_CODEX_LOG,
    FAKE_CODEX_SCENARIO: scenario,
    FAKE_CODEX_READY_FILE: ready,
  });
  const started = Date.now();
  try {
    const error = await importClaudeSession(cwd, transcript, {
      timeoutMs: timing.timeoutMs,
      closeGraceMs: timing.graceMs,
      interruptGraceMs: timing.graceMs,
      terminateGraceMs: timing.graceMs,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    return { error, elapsed: Date.now() - started, serverPid: Number(await waitForFile(ready)), fake };
  } finally {
    process.env = saved;
  }
}

test("transfer gives up on an app-server that never answers and reaps it", async () => {
  const { error, elapsed, serverPid, fake } = await importInProcess("transfer-hang", { timeoutMs: 500, graceMs: 200 });
  assert.ok(error instanceof TransferError, String(error));
  assert.match(error.message, /timed out/);
  assert.ok(elapsed < 5_000, `took ${elapsed} ms`);
  assert.ok(await waitUntilGone(serverPid));
  // Closing stdin was enough for a server that honors it.
  assert.ok(fake.readLog().some((call) => call.appServerClosed));
});

test("transfer kills an app-server that ignores stdin, SIGINT, and SIGTERM", async () => {
  const { error, serverPid, fake } = await importInProcess("transfer-stubborn", { timeoutMs: 300, graceMs: 200 });
  assert.ok(error instanceof TransferError, String(error));
  assert.ok(await waitUntilGone(serverPid), "the app-server survived SIGKILL");
  const ignored = fake
    .readLog()
    .filter((call) => call.ignored)
    .map((call) => call.signal);
  assert.deepEqual(ignored, ["SIGINT", "SIGTERM"]);
});

test("transfer accepts --source with ~ expansion", () => {
  const { fake, cwd } = setup();
  const result = runAdapter("transfer", "--source ~/.claude/projects/-repo/session-1.jsonl", { env: fake.env, cwd });
  assert.equal(result.status, 0, result.stderr);
});

test("transfer refuses sources that are not .jsonl transcripts under ~/.claude/projects", () => {
  const { fake, transcript, cwd } = setup();
  const outside = path.join(makeTempDir(), "other.jsonl");
  fs.writeFileSync(outside, "{}\n");
  const link = path.join(path.dirname(transcript), "link.jsonl");
  fs.symlinkSync(outside, link);
  const text = path.join(path.dirname(transcript), "notes.txt");
  fs.writeFileSync(text, "x");

  for (const source of [outside, link, text, path.join(path.dirname(transcript), "missing.jsonl")]) {
    const result = runAdapter("transfer", `--source ${source}`, { env: fake.env, cwd });
    assert.equal(result.status, 2, `${source}: ${result.stderr}`);
  }
  const none = runAdapter("transfer", "", { env: fake.env, cwd });
  assert.equal(none.status, 2);
  assert.match(firstLine(none.stderr), /--source/);
  assert.equal(fake.readLog().length, 0);
});

test("transfer explains how to update an old Codex and still reaps the app-server", () => {
  const { fake, transcript, cwd } = setup("transfer-unsupported");
  const result = runAdapter("transfer", `--source ${transcript}`, { env: fake.env, cwd });
  assert.equal(result.status, 1);
  assert.match(firstLine(result.stderr), /cannot import Claude sessions.*npm install -g @openai\/codex@latest/);
  assert.ok(fake.readLog().some((call) => call.appServerClosed));
});

test("transfer fails when Codex recorded no imported thread", () => {
  const { fake, transcript, cwd } = setup("transfer-no-ledger");
  const result = runAdapter("transfer", `--source ${transcript}`, { env: fake.env, cwd });
  assert.equal(result.status, 1);
  assert.match(firstLine(result.stderr), /did not record an imported thread/);
});

test("transfer without codex exits 3", () => {
  const fake = makeFakeEnv({ codex: false });
  const projectDir = path.join(fake.home, ".claude", "projects", "p");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "s.jsonl"), "{}\n");
  const result = runAdapter("transfer", `--source ${path.join(projectDir, "s.jsonl")}`, {
    env: fake.env,
    cwd: makeTempDir(),
  });
  assert.equal(result.status, 3, result.stderr);
});
