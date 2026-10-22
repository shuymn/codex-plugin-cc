import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// status is null when git could not run, was killed, or hit the timeout.
export type GitResult = { status: number | null; stdout: string; stderr: string };

export type GitOptions = { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number };

// Large enough for `git ls-files -z` of a big repository.
const MAX_GIT_OUTPUT = 256 * 1024 * 1024;
// No git call may hang a hook or command forever.
const DEFAULT_GIT_TIMEOUT_MS = 30_000;

// Repository-derived values only ever go to git as argv, never through a shell.
export function git(cwd: string, args: readonly string[], options: GitOptions = {}): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: MAX_GIT_OUTPUT,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.input === undefined ? {} : { input: options.input }),
    timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
  });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// A git call that failed for a reason other than being outside a repository:
// a timeout, a broken config, a corrupt index.
export class GitError extends Error {}

function gitFailure(args: readonly string[], result: GitResult): GitError {
  const detail = result.stderr.trim().split("\n").at(-1) ?? "";
  const reason = detail || (result.status === null ? "timed out or could not run" : `exit ${String(result.status)}`);
  return new GitError(`git ${args[0] ?? ""} failed: ${reason}`);
}

// Error messages in English, so they can be recognized.
const C_LOCALE_ENV = { LC_ALL: "C" };

// Whether a failed git call reported that the directory is not in a repository.
export function isNotGitRepository(result: GitResult): boolean {
  return result.status === 128 && /not a git repository/.test(result.stderr);
}

// null only when Git confirmed that cwd is outside a repository; any other
// failure throws GitError.
export function gitToplevel(cwd: string): string | null {
  const args = ["rev-parse", "--show-toplevel"];
  const result = git(cwd, args, { env: { ...process.env, ...C_LOCALE_ENV } });
  if (result.status !== 0) {
    if (isNotGitRepository(result)) {
      return null;
    }
    throw gitFailure(args, result);
  }
  const root = result.stdout.trim();
  if (!root) {
    throw gitFailure(args, result);
  }
  return root;
}

// The form a workspace root is stored and compared in: its real path, or the
// resolved path when it does not exist.
export function canonicalWorkspaceRoot(workspaceRoot: string): string {
  try {
    return fs.realpathSync(workspaceRoot);
  } catch {
    return path.resolve(workspaceRoot);
  }
}

// The repository root, or cwd itself only when it is confirmed to be outside
// Git. Throws GitError when that cannot be told.
export function resolveWorkspaceRoot(cwd: string): string {
  return gitToplevel(cwd) ?? cwd;
}

// Throws GitError unless `git status` finished normally.
export function hasUncommittedChanges(cwd: string): boolean {
  const args = ["status", "--porcelain", "--untracked-files=all"];
  const result = git(cwd, args);
  if (result.status !== 0) {
    throw gitFailure(args, result);
  }
  return result.stdout.trim() !== "";
}

// Resolves a ref to a commit id. Values starting with "-" are refused so a ref
// can never be read as a git option.
export function resolveCommit(cwd: string, ref: string): string | null {
  if (ref === "" || ref.startsWith("-")) {
    return null;
  }
  const result = git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  return result.status === 0 ? result.stdout.trim() || null : null;
}

export function detectDefaultBranch(cwd: string): string | null {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.slice("refs/remotes/".length);
    }
  }
  for (const candidate of ["main", "master", "trunk"]) {
    if (git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]).status === 0) {
      return candidate;
    }
    if (git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]).status === 0) {
      return `origin/${candidate}`;
    }
  }
  return null;
}
