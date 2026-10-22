// Snapshots a workspace's working tree as one Git tree id: tracked, untracked
// (not ignored), and deleted files all count. The tree is built in a temporary
// index, so the user's index, refs, and working tree are never written. The
// objects it writes are unreferenced loose objects that `git gc` prunes.
//
// The hook runs outside Codex's sandbox, so the snapshot must not start any
// program the repository's configuration names: every git call turns off
// fsmonitor and hooks, files with a filter attribute make the snapshot fail,
// every configured filter driver is turned off, and
// repositories with submodules are not snapshotted at all.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { git, type GitResult } from "./git.ts";

export type Snapshot =
  | { kind: "tree"; tree: string }
  | { kind: "not-git" }
  // Inside a repository, but no tree was built. submodules: the repository's
  // submodule paths, whose contents the caller must review some other way.
  | { kind: "failed"; reason: string; submodules: string[] };

export type SnapshotOptions = {
  timeoutMs?: number;
  // Test seam: runs right before `git add`, after every check.
  beforeAdd?: () => void;
};

export const SNAPSHOT_TIMEOUT_MS = 30_000;

const TREE_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Configuration that would otherwise run programs: fsmonitor during index
// reads, hooks such as post-index-change during index writes. The untracked
// cache is off so the temporary index never depends on the user's.
const SAFE_CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false"];

// GIT_OPTIONAL_LOCKS: no optional locks, so the user's index is never
// refreshed. GIT_NO_LAZY_FETCH: a partial clone never fetches a missing object
// (which would run the remote's transport, such as core.sshCommand). LC_ALL:
// error messages stay in English so "not a git repository" can be recognized.
const SAFE_ENV = { GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", LC_ALL: "C" };

export function isTreeId(value: unknown): value is string {
  return typeof value === "string" && TREE_ID.test(value);
}

// --no-lazy-fetch (Git 2.45 and later) makes an older Git fail every call
// instead of silently fetching, so the gate then reviews without a snapshot.
function safeGit(
  root: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {},
) {
  return git(root, ["--no-lazy-fetch", ...SAFE_CONFIG, ...args], {
    timeoutMs: SNAPSHOT_TIMEOUT_MS,
    ...options,
    env: { ...process.env, ...SAFE_ENV, ...options.env },
  });
}

class SnapshotFailure extends Error {
  readonly submodules: string[];

  constructor(message: string, submodules: string[] = []) {
    super(message);
    this.submodules = submodules;
  }
}

type Run = (args: readonly string[], options?: { env?: Record<string, string>; input?: string }) => GitResult;

function runner(root: string, timeoutMs: number): Run {
  const deadline = Date.now() + timeoutMs;
  const timedOut = () => new SnapshotFailure(`the snapshot timed out after ${timeoutMs / 1000} seconds`);
  return (args, options = {}) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw timedOut();
    }
    const result = safeGit(root, args, { ...options, timeoutMs: remaining });
    if (result.status === null && Date.now() >= deadline) {
      throw timedOut();
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

// Gitlink entries (submodules and embedded repositories) in an index: the
// user's, or the temporary one with env. Looking inside a submodule would run
// git there, under the submodule's own configuration, so the snapshot stops.
function submodulePaths(run: Run, env?: Record<string, string>): string[] {
  const paths = new Set<string>();
  // -z --stage records: "<mode> <object> <stage>\t<path>".
  const listing = run(["ls-files", "-z", "--stage"], env === undefined ? {} : { env });
  for (const record of check(listing, "ls-files").split("\0")) {
    const tab = record.indexOf("\t");
    if (tab !== -1 && record.startsWith("160000 ")) {
      paths.add(record.slice(tab + 1));
    }
  }
  return [...paths];
}

// Paths `git add -A` would read whose `filter` attribute is set. Building the
// tree would run that filter (Git LFS, for example) outside Codex's sandbox.
function filteredPaths(run: Run): string[] {
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

// `-c` options that turn off every configured filter driver, so a filter
// attribute that appears after filteredPaths ran still cannot start one.
// Empty clean and process commands make Git store the file as is.
function disabledFilterConfig(run: Run): string[] {
  const result = run(["config", "-z", "--name-only", "--get-regexp", "^filter\\."]);
  // Exit 1: no filter driver is configured.
  if (result.status === 1) {
    return [];
  }
  const args: string[] = [];
  const drivers = new Set<string>();
  for (const key of check(result, "config").split("\0")) {
    const lastDot = key.lastIndexOf(".");
    if (key.startsWith("filter.") && lastDot > "filter.".length) {
      drivers.add(key.slice("filter.".length, lastDot));
    }
  }
  for (const driver of drivers) {
    // `-c name=value` splits at the first "=", so such a name cannot be overridden.
    if (driver.includes("=")) {
      throw new SnapshotFailure("a configured filter driver cannot be turned off for the snapshot");
    }
    args.push(
      "-c",
      `filter.${driver}.clean=`,
      "-c",
      `filter.${driver}.process=`,
      "-c",
      `filter.${driver}.required=false`,
    );
  }
  return args;
}

function rejectSubmodules(submodules: string[]): void {
  if (submodules.length > 0) {
    throw new SnapshotFailure("the repository has submodules, which the snapshot does not look into", submodules);
  }
}

// True only when Git confirmed the directory is not in a work tree. Any other
// failure, such as a broken config, happens inside a repository.
function isOutsideWorkTree(result: GitResult): boolean {
  return result.status === 0
    ? result.stdout.trim() === "false"
    : result.status === 128 && /not a git repository/.test(result.stderr);
}

export function takeSnapshot(root: string, options: SnapshotOptions = {}): Snapshot {
  let tempDir: string | null = null;
  try {
    const plainRun = runner(root, options.timeoutMs ?? SNAPSHOT_TIMEOUT_MS);
    const inside = plainRun(["rev-parse", "--is-inside-work-tree"]);
    if (isOutsideWorkTree(inside)) {
      return { kind: "not-git" };
    }
    if (inside.status !== 0) {
      check(inside, "rev-parse");
    }
    // Not only `git add`: any command that writes the index may re-read a
    // racily clean file through its filter, so every later call has the
    // drivers turned off.
    const noFilters = disabledFilterConfig(plainRun);
    const run: Run = (args, runOptions) => plainRun([...noFilters, ...args], runOptions);

    rejectSubmodules(submodulePaths(run));
    const filtered = filteredPaths(run);
    if (filtered.length > 0) {
      throw new SnapshotFailure(`files use a Git filter (${filtered[0]}), which the snapshot will not run`);
    }

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-snapshot-"));
    const env = { GIT_INDEX_FILE: path.join(tempDir, "index") };
    // A HEAD commit whose tree is missing must fail, not look like a new repository.
    const hasHead = run(["rev-parse", "--verify", "--quiet", "HEAD"]).status === 0;
    check(run(hasHead ? ["read-tree", "HEAD"] : ["read-tree", "--empty"], { env }), "read-tree");
    // HEAD's submodules, even ones removed from the user's index.
    rejectSubmodules(submodulePaths(run, env));
    options.beforeAdd?.();
    check(run(["add", "-A"], { env }), "add");
    // Untracked embedded repositories, which `git add` records as gitlinks.
    rejectSubmodules(submodulePaths(run, env));
    const tree = check(run(["write-tree"], { env }), "write-tree").trim();
    if (!isTreeId(tree)) {
      throw new SnapshotFailure("git write-tree returned no tree id");
    }
    return { kind: "tree", tree };
  } catch (error) {
    if (error instanceof SnapshotFailure) {
      return { kind: "failed", reason: error.message, submodules: error.submodules };
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
  const result = safeGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"]);
  const tree = result.stdout.trim();
  return result.status === 0 && isTreeId(tree) ? tree : null;
}

// The empty tree in the repository's hash format.
export function emptyTree(root: string): string | null {
  const result = safeGit(root, ["hash-object", "-t", "tree", "--stdin"], { input: "" });
  const tree = result.stdout.trim();
  return result.status === 0 && isTreeId(tree) ? tree : null;
}

// Whether a tree object exists; a tree approved long ago may have been pruned.
export function treeExists(root: string, tree: string): boolean {
  if (!isTreeId(tree)) {
    return false;
  }
  const result = safeGit(root, ["cat-file", "-t", tree]);
  return result.status === 0 && result.stdout.trim() === "tree";
}

// The tree a session starts from: HEAD's, the empty tree before the first
// commit, or null outside Git (and when Git fails).
export function sessionStartTree(root: string): string | null {
  const inside = safeGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return null;
  }
  const head = safeGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return head.status === 0 ? headTree(root) : emptyTree(root);
}
