// The change report of a write-capable run: which files of the working tree
// differ between the snapshot taken before Codex started and the one taken
// after its process group was gone.

import fs from "node:fs";
import path from "node:path";

import { escapeLine } from "./escape.ts";
import { gitFailure } from "./git.ts";
import { safeGit, type Snapshot } from "./snapshot.ts";

// How many changed paths the report prints; beyond this the full list goes to
// changes.txt in the run directory.
const MAX_LISTED_CHANGES = 10;

type ChangeEntry = { status: string; path: string };

// Why the report could not tell, as categories for the run log.
export type UnknownCategory = "not-git" | "snapshot-failed" | "interrupted" | "reap-error";

export type ChangeReport =
  | { kind: "changes"; baseline: string; final: string; entries: ChangeEntry[] }
  | { kind: "unknown"; category: UnknownCategory; reason: string; baseline: string | null }
  | { kind: "read-only" };

// The unknown report for a snapshot that produced no tree.
export function snapshotProblem(
  snapshot: Exclude<Snapshot, { kind: "tree" }>,
  which: "baseline" | "final",
  baseline: string | null,
): ChangeReport {
  if (snapshot.kind === "not-git") {
    return { kind: "unknown", category: "not-git", reason: "not in a Git working tree", baseline };
  }
  return {
    kind: "unknown",
    category: "snapshot-failed",
    reason: `${which} snapshot failed: ${snapshot.reason}`,
    baseline,
  };
}

// Compares two snapshot trees of the repository at root (ids takeSnapshot
// validated). Paths are relative to the workspace root.
export function compareTrees(root: string, baseline: string, final: string): ChangeReport {
  const args = ["diff-tree", "-r", "-z", "--no-renames", "--name-status", baseline, final];
  const result = safeGit(root, args);
  if (result.status !== 0) {
    return { kind: "unknown", category: "snapshot-failed", reason: gitFailure(args, result).message, baseline };
  }
  // -z --name-status records: <status> NUL <path> NUL, repeated.
  const fields = result.stdout.split("\0");
  const entries: ChangeEntry[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    entries.push({ status: fields[index] ?? "", path: fields[index + 1] ?? "" });
  }
  return { kind: "changes", baseline, final, entries };
}

// The `changes:` line and the listing under it. Writes changes.txt into
// runDir when more than MAX_LISTED_CHANGES paths changed.
export function formatChanges(report: ChangeReport, workspaceRoot: string, runDir: string): string[] {
  if (report.kind === "read-only") {
    return ["changes: not checked: read-only"];
  }
  if (report.kind === "unknown") {
    const baseline = report.baseline === null ? "" : ` (baseline ${report.baseline})`;
    return [`changes: unknown: ${escapeLine(report.reason)}${baseline}`];
  }
  if (report.entries.length === 0) {
    return ["changes: none"];
  }
  const lines = [
    `changes: ${report.entries.length} files (baseline ${report.baseline}, paths relative to ${escapeLine(workspaceRoot)})`,
    ...report.entries.slice(0, MAX_LISTED_CHANGES).map((entry) => `  ${entry.status} ${escapeLine(entry.path)}`),
  ];
  if (report.entries.length > MAX_LISTED_CHANGES) {
    const listPath = path.join(runDir, "changes.txt");
    const listing = [
      `baseline ${report.baseline}`,
      `final ${report.final}`,
      ...report.entries.map((entry) => `${entry.status}\t${escapeLine(entry.path)}`),
      "",
    ].join("\n");
    try {
      fs.writeFileSync(listPath, listing, { flag: "wx" });
      lines.push(`  ... full list: ${escapeLine(listPath)}`);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
      lines.push(
        `  ... ${report.entries.length - MAX_LISTED_CHANGES} more; could not write ${escapeLine(listPath)} (${code})`,
      );
    }
  }
  return lines;
}
