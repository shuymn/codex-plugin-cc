import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { firstLine, makeFakeEnv, makeTempDir, runAdapter } from "./helpers.ts";

function setup(scenario = "ok") {
  const fake = makeFakeEnv({ scenario });
  const projectDir = path.join(fake.home, ".claude", "projects", "-repo");
  fs.mkdirSync(projectDir, { recursive: true });
  const transcript = path.join(projectDir, "session-1.jsonl");
  fs.writeFileSync(transcript, '{"type":"user"}\n');
  const cwd = makeTempDir();
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
  // stdin was closed and the app-server exited before the adapter did.
  assert.ok(calls.some((call) => call.appServerClosed));
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
