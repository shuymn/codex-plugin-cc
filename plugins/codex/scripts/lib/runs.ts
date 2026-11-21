// Run directories and the run log:
//   <state>/runs/<run id>/   result.md (Codex's -o file), changes.txt
//   <state>/runs.jsonl       one metadata line per run
// A run id is the UTC start time plus random hex, so ids sort by time and
// concurrent runs never share a directory.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { UnknownCategory } from "./changes.ts";
import { stateDir } from "./env.ts";

const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const RUN_DIR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type RunLogEntry = {
  run: string;
  time: string;
  sandbox: string;
  continued: boolean;
  exit: number;
  durationMs: number;
  // Changed-file count; null when not checked (read-only) or unknown.
  changes: number | null;
  unknown?: UnknownCategory;
  snapshotMs?: { baseline: number; final?: number };
};

function runsDir(): string {
  return path.join(stateDir(), "runs");
}

export function newRunId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll(/[-:]/g, "");
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

// Deletes run directories whose modification time is older than 7 days. Only
// real directories (not symlinks) named like a run id are touched, and errors
// are ignored: pruning must never stop a run.
export function pruneRunDirs(now: number): void {
  const dir = runsDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!RUN_ID_PATTERN.test(name)) {
      continue;
    }
    const entry = path.join(dir, name);
    try {
      const stat = fs.lstatSync(entry);
      if (stat.isDirectory() && now - stat.mtimeMs > RUN_DIR_MAX_AGE_MS) {
        // rmSync removes symlinks inside the directory without following them.
        fs.rmSync(entry, { recursive: true, force: true });
      }
    } catch {
      // Best effort; the next run tries again.
    }
  }
}

// Creates the run's private directory. Fails if it already exists.
export function createRunDir(runId: string): string {
  const dir = path.join(runsDir(), runId);
  fs.mkdirSync(runsDir(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(dir, { mode: 0o700 });
  return dir;
}

// Appends one line with a single write, so concurrent runs never interleave
// within a line. Holds no prompt, result, path, or raw error text.
export function appendRunLog(entry: RunLogEntry): void {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(stateDir(), "runs.jsonl"), `${JSON.stringify(entry)}\n`);
}
