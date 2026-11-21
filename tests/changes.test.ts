import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { git, makeFakeEnv, makeRepo, makeTempDir, outputLine, runRunner, writePrompt } from "./helpers.ts";

function runWithActions(cwd: string, fake: ReturnType<typeof makeFakeEnv>, actions: object[]) {
  return runRunner(["--prompt-file", writePrompt(), "--cwd", cwd], {
    env: { ...fake.env, FAKE_CODEX_ACTIONS: JSON.stringify(actions) },
    cwd: makeTempDir(),
  });
}

// H8
test("added, modified, and deleted files are listed as A, M, D relative to the workspace root", () => {
  const fake = makeFakeEnv();
  const repo = makeRepo(fake.env);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "gone.ts"), "x\n");
  git(repo, ["add", "src/gone.ts"], fake.env);
  git(repo, ["commit", "-q", "-m", "add"], fake.env);
  // Uncommitted work from before the run is part of the baseline, not a change.
  fs.writeFileSync(path.join(repo, "dirty.txt"), "before the run\n");

  // Codex runs in a subdirectory; the paths are still relative to the root.
  const result = runWithActions(path.join(repo, "src"), fake, [
    { write: "new.ts", content: "new\n" },
    { write: "../README.md", content: "changed\n" },
    { delete: "gone.ts" },
  ]);
  assert.equal(result.status, 0, result.stderr);
  const baseline = /baseline ([0-9a-f]{40})/.exec(outputLine(result.stdout, "changes") ?? "")?.[1];
  assert.ok(baseline);
  assert.equal(outputLine(result.stdout, "changes"), `3 files (baseline ${baseline}, paths relative to ${repo})`);
  const listing = result.stdout.split("\n").filter((line) => line.startsWith("  "));
  assert.deepEqual(listing, ["  M README.md", "  D src/gone.ts", "  A src/new.ts"]);
  // The baseline names the tree before the run, including the uncommitted file.
  assert.equal(git(repo, ["cat-file", "-p", `${baseline}:dirty.txt`], fake.env), "before the run");
});

test("a file modified and restored within the run reports none", () => {
  const fake = makeFakeEnv();
  const repo = makeRepo(fake.env);
  const result = runWithActions(repo, fake, [
    { write: "README.md", content: "broken\n" },
    { write: "probe.txt", content: "temporary\n" },
    { delete: "probe.txt" },
    { write: "README.md", content: "hello\n" },
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(outputLine(result.stdout, "changes"), "none");
});

test("outside Git the report is unknown with the reason", () => {
  const fake = makeFakeEnv();
  const plain = makeTempDir();
  const result = runWithActions(plain, fake, [{ write: "new.txt", content: "x" }]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(outputLine(result.stdout, "changes"), "unknown: not in a Git working tree");
});

test("a workspace root that ends in a space is measured as is, not as the trimmed path", () => {
  const fake = makeFakeEnv();
  const repo = makeRepo(fake.env);
  const parent = makeTempDir();
  const spaced = path.join(parent, "wt ");
  git(repo, ["worktree", "add", "-q", "-b", "spaced", spaced], fake.env);
  // A sibling at the trimmed path, which a trimmed root would measure instead.
  git(repo, ["worktree", "add", "-q", "-b", "plain", path.join(parent, "wt")], fake.env);
  const result = runWithActions(spaced, fake, [{ write: "only-in-spaced.txt", content: "x" }]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(outputLine(result.stdout, "changes") ?? "", new RegExp(`paths relative to ${spaced}\\)$`));
  assert.match(result.stdout, /\n {2}A only-in-spaced\.txt\n/);
});
