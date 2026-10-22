import fs from "node:fs";
import path from "node:path";

import { UsageError } from "./args.ts";
import { pluginDataDir, writeFileAtomic } from "./env.ts";
import { canonicalWorkspaceRoot } from "./git.ts";
import { isRecord } from "./json.ts";

// Maps a Claude session to the Codex threads it started:
//   threads/<sessionId>/<threadId>.json  {cwd, updatedAt}
//   threads/<sessionId>/latest           <threadId>
// One file per thread, so parallel tasks in one session never drop each
// other's records; the last writer of `latest` wins.

const THREAD_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const LATEST_FILE = "latest";

type ThreadRecord = { cwd: string; updatedAt: string };

function sessionDir(sessionId: string): string {
  return path.join(pluginDataDir(), "threads", sessionId);
}

function isValidThreadId(threadId: string): boolean {
  return THREAD_ID_PATTERN.test(threadId);
}

export function recordThread(sessionId: string, threadId: string, workspaceRoot: string): boolean {
  if (!isValidThreadId(threadId)) {
    return false;
  }
  const dir = sessionDir(sessionId);
  const record: ThreadRecord = { cwd: canonicalWorkspaceRoot(workspaceRoot), updatedAt: new Date().toISOString() };
  writeFileAtomic(path.join(dir, `${threadId}.json`), `${JSON.stringify(record)}\n`);
  writeFileAtomic(path.join(dir, LATEST_FILE), `${threadId}\n`);
  return true;
}

// Returns the workspace root recorded for the thread; updatedAt is written
// for inspection but not read back.
function readRecordedCwd(sessionId: string, threadId: string): string | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(sessionDir(sessionId), `${threadId}.json`), "utf8"));
    if (isRecord(parsed) && typeof parsed.cwd === "string") {
      return parsed.cwd;
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
// of the session is used.
export function resolveResumeThread(sessionId: string | null, workspaceRoot: string, requested?: string): string {
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
  const recordedCwd = readRecordedCwd(sessionId, threadId);
  if (recordedCwd === null) {
    throw new UsageError(
      `cannot resume: thread ${threadId} was not started from this Claude session. Start a new task, or use \`codex resume ${threadId}\` in a terminal.`,
    );
  }
  const root = canonicalWorkspaceRoot(workspaceRoot);
  if (recordedCwd !== root) {
    throw new UsageError(
      `cannot resume: thread ${threadId} belongs to ${recordedCwd}, not ${root}. Pass --cwd ${recordedCwd} to resume it there.`,
    );
  }
  return threadId;
}
