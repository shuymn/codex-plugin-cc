import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// status is null when git could not run, was killed, or hit the timeout.
export type GitResult = { status: number | null; stdout: string; stderr: string };

// env: variables set on purpose for this call, applied over gitEnv(). Never
// pass a spread of process.env, which would bring back the variables gitEnv()
// removes.
export type GitOptions = { env?: Record<string, string>; input?: string; timeoutMs?: number };

// Large enough for `git ls-files -z` of a big repository.
const MAX_GIT_OUTPUT = 256 * 1024 * 1024;
// No git call may hang the runner forever.
const DEFAULT_GIT_TIMEOUT_MS = 30_000;

// Variables that choose the repository, index, or object store instead of
// letting Git find them from the working directory. A caller that runs inside
// another repository's hook or `git -C` context can inherit them, and they
// would then point every call, and Codex, at that repository instead of --cwd.
// Variables that only limit discovery, such as GIT_CEILING_DIRECTORIES, stay.
export const REPOSITORY_SELECTION_VARIABLES: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
];

// This process's environment without the repository-selection variables, so
// Git resolves the repository from the directory it runs in. process.env
// itself is never changed.
export function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of REPOSITORY_SELECTION_VARIABLES) {
    delete env[name];
  }
  return env;
}

// Repository-derived values only ever go to git as argv, never through a shell.
export function git(cwd: string, args: readonly string[], options: GitOptions = {}): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: MAX_GIT_OUTPUT,
    env: { ...gitEnv(), ...options.env },
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

// The output of `git rev-parse <flags>`. null only when Git confirmed that cwd
// is outside a repository; any other failure throws GitError.
function revParse(cwd: string, flags: readonly string[]): string | null {
  const args = ["rev-parse", ...flags];
  const result = git(cwd, args, { env: C_LOCALE_ENV });
  if (result.status !== 0) {
    if (isNotGitRepository(result)) {
      return null;
    }
    throw gitFailure(args, result);
  }
  const value = result.stdout.trim();
  if (!value) {
    throw gitFailure(args, result);
  }
  return value;
}

export function gitToplevel(cwd: string): string | null {
  return revParse(cwd, ["--show-toplevel"]);
}

// The real path of the repository's common Git directory, which all worktrees
// of one repository share.
export function gitCommonDir(cwd: string): string | null {
  const dir = revParse(cwd, ["--path-format=absolute", "--git-common-dir"]);
  return dir === null ? null : canonicalWorkspaceRoot(dir);
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
