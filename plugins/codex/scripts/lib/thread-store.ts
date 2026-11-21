import fs from "node:fs";
import path from "node:path";

import { stateDir, writeFileAtomic } from "./env.ts";
import { canonicalWorkspaceRoot } from "./git.ts";
import { isRecord } from "./json.ts";

// The Codex threads codex-run started, one file per thread:
//   <state>/threads/<threadId>.json  {cwd, repo, updatedAt}
// cwd is the canonical workspace root of the latest run on the thread, and
// repo the real path of its common Git directory, or null outside Git. One
// file per thread, written atomically, so parallel runs never drop each
// other's records.

const THREAD_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

type ThreadRecord = { cwd: string; repo: string | null; updatedAt: string };

// A --thread that may not be continued here; the message says why and what to
// do instead.
export class ThreadRefusedError extends Error {
  override name = "ThreadRefusedError";
}

function recordPath(threadId: string): string {
  return path.join(stateDir(), "threads", `${threadId}.json`);
}

function isValidThreadId(threadId: string): boolean {
  return THREAD_ID_PATTERN.test(threadId);
}

// Writes nothing when the id is not safe as a file name. Throws when the
// record cannot be written.
export function recordThread(threadId: string, workspaceRoot: string, repo: string | null): void {
  if (!isValidThreadId(threadId)) {
    return;
  }
  const record: ThreadRecord = {
    cwd: canonicalWorkspaceRoot(workspaceRoot),
    repo,
    updatedAt: new Date().toISOString(),
  };
  writeFileAtomic(recordPath(threadId), `${JSON.stringify(record)}\n`);
}

// updatedAt is written for inspection but not read back.
function readRecord(threadId: string): { cwd: string; repo: string | null } | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(recordPath(threadId), "utf8"));
    if (isRecord(parsed) && typeof parsed.cwd === "string") {
      return { cwd: parsed.cwd, repo: typeof parsed.repo === "string" ? parsed.repo : null };
    }
  } catch {
    // A missing or unreadable record means there is nothing to continue.
  }
  return null;
}

// Checks that `threadId` may be continued in this workspace, or throws
// ThreadRefusedError. A thread recorded in Git continues in any worktree of
// the same repository (the same common Git directory) and never matches by
// path alone; a thread recorded outside Git continues only in the same
// directory, and only while that directory is still outside Git.
export function checkThread(threadId: string, workspaceRoot: string, repo: string | null): void {
  if (!isValidThreadId(threadId)) {
    throw new ThreadRefusedError(`cannot continue: invalid thread id ${JSON.stringify(threadId)}.`);
  }
  const recorded = readRecord(threadId);
  if (recorded === null) {
    throw new ThreadRefusedError(
      `cannot continue: thread ${threadId} was not started by codex-run. Use \`codex resume ${threadId}\` in a terminal instead.`,
    );
  }
  const matches =
    recorded.repo !== null
      ? recorded.repo === repo
      : repo === null && recorded.cwd === canonicalWorkspaceRoot(workspaceRoot);
  if (!matches) {
    const where = recorded.repo === null ? recorded.cwd : `${recorded.cwd} (repository ${recorded.repo})`;
    throw new ThreadRefusedError(
      `cannot continue: thread ${threadId} belongs to ${where}, outside this repository. Pass a --cwd in that repository, or use \`codex resume ${threadId}\` in a terminal.`,
    );
  }
}
