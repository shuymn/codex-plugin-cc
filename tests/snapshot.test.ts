import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  emptyTree,
  headTree,
  isTreeId,
  type Snapshot,
  takeSnapshot,
  treeExists,
} from "../plugins/codex/scripts/lib/snapshot.ts";
import { git, makeFakeEnv, makeRepo, makeTempDir } from "./helpers.ts";

// takeSnapshot runs git with this process's environment; give it the same
// isolated one the helpers use for the test repositories.
const fake = makeFakeEnv();
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) {
    delete process.env[key];
  }
}
for (const [key, value] of Object.entries(fake.env)) {
  if (key.startsWith("GIT_")) {
    process.env[key] = value;
  }
}

function treeOf(snapshot: Snapshot): string {
  assert.equal(snapshot.kind, "tree", JSON.stringify(snapshot));
  return snapshot.kind === "tree" ? snapshot.tree : "";
}

function write(repo: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
}

test("a clean repository snapshots to the HEAD tree", () => {
  const repo = makeRepo(fake.env);
  const tree = treeOf(takeSnapshot(repo));
  assert.ok(isTreeId(tree));
  assert.equal(tree, git(repo, ["rev-parse", "HEAD^{tree}"], fake.env));
  assert.equal(headTree(repo), tree);
});

test("tracked edits, untracked files, and deletions each change the tree; ignored files do not", () => {
  const repo = makeRepo(fake.env);
  write(repo, ".gitignore", "ignored.txt\n");
  git(repo, ["add", ".gitignore"], fake.env);
  git(repo, ["commit", "-q", "-m", "ignore"], fake.env);
  const clean = treeOf(takeSnapshot(repo));

  write(repo, "ignored.txt", "x\n");
  assert.equal(treeOf(takeSnapshot(repo)), clean);

  write(repo, "README.md", "edited\n");
  const edited = treeOf(takeSnapshot(repo));
  assert.notEqual(edited, clean);

  write(repo, "src/new.ts", "new\n");
  const added = treeOf(takeSnapshot(repo));
  assert.notEqual(added, edited);

  fs.rmSync(path.join(repo, ".gitignore"));
  const deleted = treeOf(takeSnapshot(repo));
  assert.notEqual(deleted, added);

  // The same content gives the same tree again.
  write(repo, ".gitignore", "ignored.txt\n");
  assert.equal(treeOf(takeSnapshot(repo)), added);
});

test("the snapshot follows the working tree, not what is staged", () => {
  const repo = makeRepo(fake.env);
  write(repo, "README.md", "staged\n");
  git(repo, ["add", "README.md"], fake.env);
  write(repo, "README.md", "hello\n");
  assert.equal(treeOf(takeSnapshot(repo)), headTree(repo));
});

test("a repository without commits snapshots its files, and the empty tree when it has none", () => {
  const repo = makeTempDir("codex-plugin-repo-");
  git(repo, ["init", "-q", "-b", "main"], fake.env);
  assert.equal(headTree(repo), null);
  const empty = emptyTree(repo);
  assert.equal(empty, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  assert.equal(treeOf(takeSnapshot(repo)), empty);
  write(repo, "a.txt", "a\n");
  assert.notEqual(treeOf(takeSnapshot(repo)), empty);
});

test("a directory outside Git is reported as such", () => {
  assert.deepEqual(takeSnapshot(makeTempDir()), { kind: "not-git" });
});

// EARS 11
test("taking a snapshot leaves the index, refs, and working tree untouched", () => {
  const repo = makeRepo(fake.env);
  write(repo, "staged.txt", "staged\n");
  git(repo, ["add", "staged.txt"], fake.env);
  write(repo, "README.md", "unstaged\n");
  write(repo, "untracked.txt", "untracked\n");
  fs.rmSync(path.join(repo, "staged.txt"));
  git(repo, ["tag", "v1"], fake.env);

  const state = () => ({
    status: git(repo, ["status", "--porcelain=v1", "--untracked-files=all"], fake.env),
    index: fs.readFileSync(path.join(repo, ".git", "index")).toString("base64"),
    refs: git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"], fake.env),
    head: fs.readFileSync(path.join(repo, ".git", "HEAD"), "utf8"),
    files: ["README.md", "untracked.txt"].map((file) => fs.readFileSync(path.join(repo, file), "utf8")),
    tempEntries: fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith("codex-plugin-snapshot-")),
  });
  const before = state();
  treeOf(takeSnapshot(repo));
  assert.deepEqual(state(), before);
});

test("files with a Git filter make the snapshot fail without running the filter", () => {
  for (const tracked of [true, false]) {
    const repo = makeRepo(fake.env);
    const marker = path.join(makeTempDir(), "filter-ran");
    git(repo, ["config", "filter.probe.clean", `touch "${marker}"; cat`], fake.env);
    git(repo, ["config", "filter.probe.smudge", "cat"], fake.env);
    write(repo, ".gitattributes", "*.dat filter=probe\n");
    if (tracked) {
      write(repo, "a.dat", "data\n");
      git(repo, ["-c", "filter.probe.clean=cat", "add", "."], fake.env);
      git(repo, ["commit", "-q", "-m", "filtered"], fake.env);
    } else {
      write(repo, "new.dat", "data\n");
    }
    const snapshot = takeSnapshot(repo);
    assert.equal(snapshot.kind, "failed", `tracked=${tracked}`);
    assert.match(snapshot.kind === "failed" ? snapshot.reason : "", /filter/);
    assert.equal(fs.existsSync(marker), false);
  }
});

test("an attribute file that names no filter does not stop the snapshot", () => {
  const repo = makeRepo(fake.env);
  write(repo, ".gitattributes", "*.md text eol=lf\n");
  treeOf(takeSnapshot(repo));
});

test("a Git error inside a repository makes the snapshot fail, not look like a non-repository", () => {
  const repo = makeRepo(fake.env);
  const tree = git(repo, ["rev-parse", "HEAD^{tree}"], fake.env);
  fs.rmSync(path.join(repo, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
  assert.equal(takeSnapshot(repo).kind, "failed");
});

test("a snapshot past its deadline fails", () => {
  const snapshot = takeSnapshot(makeRepo(fake.env), { timeoutMs: 0 });
  assert.equal(snapshot.kind, "failed");
  assert.match(snapshot.kind === "failed" ? snapshot.reason : "", /timed out/);
});

// A script that leaves a marker file when Git runs it.
function probe(name: string): { script: string; marker: string } {
  const dir = makeTempDir();
  const marker = path.join(dir, `${name}-ran`);
  const script = path.join(dir, `${name}.sh`);
  fs.writeFileSync(script, `#!/bin/sh\n/usr/bin/touch "${marker}"\nexit 1\n`, { mode: 0o755 });
  return { script, marker };
}

test("a repository with submodules is not snapshotted, and nothing inside the submodules runs", () => {
  const sub = makeRepo(fake.env);
  const repo = makeRepo(fake.env);
  git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "libs/sub dir"], fake.env);
  git(repo, ["commit", "-q", "-m", "add submodule"], fake.env);
  const inner = path.join(repo, "libs", "sub dir");
  const fsmonitor = probe("inner-fsmonitor");
  git(inner, ["config", "core.fsmonitor", fsmonitor.script], fake.env);
  const filter = probe("inner-filter");
  git(inner, ["config", "filter.probe.clean", filter.script], fake.env);
  write(inner, ".gitattributes", "*.md filter=probe\n");
  write(inner, "README.md", "changed inside\n");

  const snapshot = takeSnapshot(repo);
  assert.equal(snapshot.kind, "failed");
  assert.deepEqual(snapshot.kind === "failed" ? snapshot.submodules : null, ["libs/sub dir"]);
  assert.match(snapshot.kind === "failed" ? snapshot.reason : "", /submodule/);
  assert.equal(fs.existsSync(fsmonitor.marker), false);
  assert.equal(fs.existsSync(filter.marker), false);
});

test("the snapshot runs neither the repository's fsmonitor nor its hooks", () => {
  const repo = makeRepo(fake.env);
  const fsmonitor = probe("fsmonitor");
  const hook = probe("post-index-change");
  git(repo, ["config", "core.fsmonitor", fsmonitor.script], fake.env);
  fs.copyFileSync(hook.script, path.join(repo, ".git", "hooks", "post-index-change"));
  fs.chmodSync(path.join(repo, ".git", "hooks", "post-index-change"), 0o755);
  write(repo, "README.md", "edited\n");
  write(repo, "new.txt", "new\n");

  treeOf(takeSnapshot(repo));
  assert.equal(fs.existsSync(fsmonitor.marker), false);
  assert.equal(fs.existsSync(hook.marker), false);

  // The probes do run when Git is used plainly, so the test can fail.
  git(repo, ["add", "-A"], fake.env);
  assert.equal(fs.existsSync(fsmonitor.marker), true);
  assert.equal(fs.existsSync(hook.marker), true);
});

test("a filter attribute added after the filter check still does not run the filter", () => {
  const repo = makeRepo(fake.env);
  const filter = probe("late-filter");
  git(repo, ["config", "filter.late.clean", filter.script], fake.env);
  git(repo, ["config", "filter.late.process", filter.script], fake.env);
  git(repo, ["config", "filter.late.required", "true"], fake.env);
  const snapshot = takeSnapshot(repo, {
    beforeAdd: () => {
      write(repo, ".gitattributes", "*.dat filter=late\n");
      write(repo, "a.dat", "data\n");
    },
  });
  treeOf(snapshot);
  assert.equal(fs.existsSync(filter.marker), false);
  // Plain Git runs the filter, so the test can fail.
  spawnSync("git", ["add", "-A"], {
    cwd: repo,
    env: { ...fake.env, GIT_INDEX_FILE: path.join(makeTempDir(), "index") },
    timeout: 10_000,
  });
  assert.equal(fs.existsSync(filter.marker), true);
});

test("treeExists and isTreeId", () => {
  const repo = makeRepo(fake.env);
  const tree = headTree(repo) ?? "";
  assert.equal(treeExists(repo, tree), true);
  assert.equal(treeExists(repo, "0123456789abcdef0123456789abcdef01234567"), false);
  // A commit id is not a tree.
  assert.equal(treeExists(repo, git(repo, ["rev-parse", "HEAD"], fake.env)), false);
  assert.equal(isTreeId("--help"), false);
  assert.equal(isTreeId("ABCDEF0123456789abcdef0123456789abcdef01"), false);
  assert.equal(isTreeId("a".repeat(64)), true);
});
