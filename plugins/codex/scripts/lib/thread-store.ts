import fs from "node:fs";
import path from "node:path";

import { UsageError } from "./args.ts";
import { pluginDataDir, writeFileAtomic } from "./env.ts";
import { canonicalWorkspaceRoot } from "./git.ts";
import { isRecord } from "./json.ts";

// Maps a Claude session to the Codex threads it started:
//   threads/<sessionId>/<threadId>.json  {cwd, repo, updatedAt}
//   threads/<sessionId>/latest           <threadId>
// One file per thread, so parallel tasks in one session never drop each
// other's records; the last writer of `latest` wins. `repo` is the common Git
// directory, so a thread can move between worktrees of one repository; it is
// null outside Git.

const THREAD_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const LATEST_FILE = "latest";

type ThreadRecord = { cwd: string; repo: string | null; updatedAt: string };

function sessionDir(sessionId: string): string {
  return path.join(pluginDataDir(), "threads", sessionId);
}

function isValidThreadId(threadId: string): boolean {
  return THREAD_ID_PATTERN.test(threadId);
}

// `repo` is the common Git directory of the workspace, or null outside Git.
export function recordThread(sessionId: string, threadId: string, workspaceRoot: string, repo: string | null): boolean {
  if (!isValidThreadId(threadId)) {
    return false;
  }
  const dir = sessionDir(sessionId);
  const record: ThreadRecord = {
    cwd: canonicalWorkspaceRoot(workspaceRoot),
    repo,
    updatedAt: new Date().toISOString(),
  };
  writeFileAtomic(path.join(dir, `${threadId}.json`), `${JSON.stringify(record)}\n`);
  writeFileAtomic(path.join(dir, LATEST_FILE), `${threadId}\n`);
  return true;
}

// Returns where the thread was recorded; updatedAt is written for inspection
// but not read back.
function readRecord(sessionId: string, threadId: string): { cwd: string; repo: string | null } | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(sessionDir(sessionId), `${threadId}.json`), "utf8"));
    if (isRecord(parsed) && typeof parsed.cwd === "string") {
      return { cwd: parsed.cwd, repo: typeof parsed.repo === "string" ? parsed.repo : null };
    }
  } catch {
    // A missing or unreadable record means there is nothing to resume.
  }
  return null;
}

function readLatest(sessionId: string): string | null {
  try {
    return fs.readFileSync(path.join(sessionDir(sessionId), LATEST_FILE), "utf8").trim() || null;
  } catch {
    return null;
  }
}

// Returns the thread to resume, or throws a UsageError whose message says what
// to do next. `requested` is the --thread value; without it the latest thread
// of the session is used, and `repo` is as in recordThread.
export function resolveResumeThread(
  sessionId: string | null,
  workspaceRoot: string,
  repo: string | null,
  requested?: string,
): string {
  if (sessionId === null) {
    throw new UsageError(
      "cannot resume: no Claude session id (CODEX_COMPANION_SESSION_ID). Start a new task, or continue in a terminal with `codex resume`.",
    );
  }
  if (requested !== undefined && !isValidThreadId(requested)) {
    throw new UsageError(`cannot resume: invalid thread id ${JSON.stringify(requested)}.`);
  }
  const threadId = requested ?? readLatest(sessionId);
  if (threadId === null || !isValidThreadId(threadId)) {
    throw new UsageError(
      "cannot resume: this Claude session has no Codex thread yet. Start a new task without --resume.",
    );
  }
  const recorded = readRecord(sessionId, threadId);
  if (recorded === null) {
    throw new UsageError(
      `cannot resume: thread ${threadId} was not started from this Claude session. Start a new task, or use \`codex resume ${threadId}\` in a terminal.`,
    );
  }
  const root = canonicalWorkspaceRoot(workspaceRoot);
  if (recorded.cwd !== root && (recorded.repo === null || recorded.repo !== repo)) {
    throw new UsageError(
      `cannot resume: thread ${threadId} belongs to ${recorded.cwd}, and ${root} is not a worktree of the same repository. Pass --cwd ${recorded.cwd} to resume it there.`,
    );
  }
  return threadId;
}
