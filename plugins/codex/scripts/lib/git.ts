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

export function gitToplevel(cwd: string): string | null {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  return result.status === 0 ? result.stdout.trim() || null : null;
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

export function resolveWorkspaceRoot(cwd: string): string {
  return gitToplevel(cwd) ?? cwd;
}

export function hasUncommittedChanges(cwd: string): boolean {
  const result = git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  return result.status === 0 && result.stdout.trim() !== "";
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
