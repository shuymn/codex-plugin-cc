// Snapshots a workspace's working tree as one Git tree id: tracked, untracked
// (not ignored), and deleted files all count. The tree is built in a temporary
// index, so the user's index, refs, and working tree are never written. The
// objects it writes are unreferenced loose objects that `git gc` prunes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { git, type GitResult } from "./git.ts";

export type Snapshot =
  // dirtySubmodules: submodule paths with uncommitted changes, which the tree
  // (holding only each submodule's commit) cannot show.
  | { kind: "tree"; tree: string; dirtySubmodules: string[] }
  | { kind: "not-git" }
  // Inside a repository, but no tree could be built.
  | { kind: "failed"; reason: string };

export const SNAPSHOT_TIMEOUT_MS = 30_000;

const TREE_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Keeps `git status` from refreshing the user's index as a side effect.
const READ_ONLY_ENV = { GIT_OPTIONAL_LOCKS: "0" };

export function isTreeId(value: unknown): value is string {
  return typeof value === "string" && TREE_ID.test(value);
}

class SnapshotFailure extends Error {}

function runner(root: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  return (args: readonly string[], options: { env?: Record<string, string>; input?: string } = {}): GitResult => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new SnapshotFailure(`the snapshot timed out after ${timeoutMs / 1000} seconds`);
    }
    const result = git(root, args, {
      env: { ...process.env, ...READ_ONLY_ENV, ...options.env },
      timeoutMs: remaining,
      ...(options.input === undefined ? {} : { input: options.input }),
    });
    if (result.status === null && Date.now() >= deadline) {
      throw new SnapshotFailure(`the snapshot timed out after ${timeoutMs / 1000} seconds`);
    }
    return result;
  };
}

function check(result: GitResult, what: string): string {
  if (result.status !== 0) {
    const detail = result.stderr.trim().split("\n").at(-1) ?? "";
    throw new SnapshotFailure(`git ${what} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

// Paths `git add -A` would read whose `filter` attribute is set. Building the
// tree would run that filter (Git LFS, for example) outside Codex's sandbox.
function filteredPaths(run: ReturnType<typeof runner>): string[] {
  const files = check(run(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]), "ls-files");
  if (!files) {
    return [];
  }
  const fields = check(run(["check-attr", "--stdin", "-z", "filter"], { input: files }), "check-attr").split("\0");
  const found: string[] = [];
  // -z output: <path> NUL <attribute> NUL <value> NUL, repeated.
  for (let index = 0; index + 2 < fields.length; index += 3) {
    if (fields[index + 2] !== "unspecified") {
      found.push(fields[index] ?? "");
    }
  }
  return found;
}

// Reads `git status --porcelain=v2 -z`, whose third field is "S<c><m><u>" for
// a submodule: m = tracked changes inside it, u = untracked files inside it.
function findDirtySubmodules(run: ReturnType<typeof runner>): string[] {
  const records = check(run(["status", "--porcelain=v2", "-z", "--ignore-submodules=none"]), "status").split("\0");
  const dirty: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    // Fields before the path: 8 for changed, 9 for renamed, 10 for unmerged.
    const leading = { "1": 8, "2": 9, u: 10 }[record.slice(0, 1)];
    if (leading === undefined || record[1] !== " ") {
      continue;
    }
    if (record.startsWith("2 ")) {
      index += 1; // the original path of a rename follows as its own record
    }
    const fields = record.split(" ");
    const sub = fields[2] ?? "";
    if (sub.startsWith("S") && (sub[2] === "M" || sub[3] === "U")) {
      dirty.push(fields.slice(leading).join(" "));
    }
  }
  return dirty;
}

export function takeSnapshot(root: string, timeoutMs = SNAPSHOT_TIMEOUT_MS): Snapshot {
  let tempDir: string | null = null;
  try {
    const run = runner(root, timeoutMs);
    const inside = run(["rev-parse", "--is-inside-work-tree"]);
    if (inside.status !== 0 || inside.stdout.trim() !== "true") {
      return { kind: "not-git" };
    }
    const filtered = filteredPaths(run);
    if (filtered.length > 0) {
      return { kind: "failed", reason: `files use a Git filter (${filtered[0]}), which the snapshot will not run` };
    }
    const dirtySubmodules = findDirtySubmodules(run);

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-snapshot-"));
    const env = { GIT_INDEX_FILE: path.join(tempDir, "index") };
    const head = run(["rev-parse", "--verify", "--quiet", "HEAD^{tree}"]);
    const readArgs = head.status === 0 ? ["read-tree", head.stdout.trim()] : ["read-tree", "--empty"];
    check(run(readArgs, { env }), "read-tree");
    check(run(["add", "-A"], { env }), "add");
    const tree = check(run(["write-tree"], { env }), "write-tree").trim();
    if (!isTreeId(tree)) {
      return { kind: "failed", reason: "git write-tree returned no tree id" };
    }
    return { kind: "tree", tree, dirtySubmodules };
  } catch (error) {
    if (error instanceof SnapshotFailure) {
      return { kind: "failed", reason: error.message };
    }
    throw error;
  } finally {
    if (tempDir !== null) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

// The tree of HEAD, or null when HEAD has no commit yet (or outside Git).
export function headTree(root: string): string | null {
  const result = git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"]);
  const tree = result.stdout.trim();
  return result.status === 0 && isTreeId(tree) ? tree : null;
}

// The empty tree in the repository's hash format.
export function emptyTree(root: string): string | null {
  const result = git(root, ["hash-object", "-t", "tree", "--stdin"], { input: "" });
  const tree = result.stdout.trim();
  return result.status === 0 && isTreeId(tree) ? tree : null;
}

// Whether a tree object exists; a tree approved long ago may have been pruned.
export function treeExists(root: string, tree: string): boolean {
  if (!isTreeId(tree)) {
    return false;
  }
  const result = git(root, ["cat-file", "-t", tree]);
  return result.status === 0 && result.stdout.trim() === "tree";
}
