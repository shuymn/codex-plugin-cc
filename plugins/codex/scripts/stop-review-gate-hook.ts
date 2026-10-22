// Stop hook: when the review gate is on for the workspace, asks Codex for a
// read-only review of what changed in the working tree since the gate last
// approved it, and blocks the stop unless Codex allows it.
//
// The working tree is compared as Git tree snapshots (lib/snapshot.ts). An
// unchanged snapshot is allowed without calling Codex. Failures block without
// counting toward the limit; after MAX_BLOCKS consecutive blocks with findings
// the stop is allowed with the findings shown to the user. A missing codex
// lets Claude stop with a note.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readStdin } from "./lib/args.ts";
import {
  APPROVAL_OVERRIDES,
  CodexNotFoundError,
  type CodexRunResult,
  failureReason,
  runCodex,
  signalExitCode,
} from "./lib/codex-exec.ts";
import { PLUGIN_ROOT, safeSessionId } from "./lib/env.ts";
import { isReviewGateEnabled } from "./lib/gate-config.ts";
import { resolveWorkspaceRoot } from "./lib/git.ts";
import { isRecord } from "./lib/json.ts";
import { interpolate } from "./lib/prompt.ts";
import { emptyTree, headTree, isTreeId, type Snapshot, takeSnapshot, treeExists } from "./lib/snapshot.ts";
import { capReason, formatFindings, parseStopGateOutput, type StopGateOutput } from "./lib/stop-gate-output.ts";
import { readGateState, type WorkspaceState, workspaceKey, writeGateState } from "./lib/stop-gate-state.ts";

// hooks.json allows 15 minutes; stop earlier so the hook can still snapshot
// the tree again and answer.
const GATE_TIMEOUT_MS = 13 * 60 * 1000;
// Consecutive blocks with findings before the gate lets Claude stop anyway.
export const MAX_BLOCKS = 3;

const FAILURE_HINT =
  "Stop again to retry, run /codex:review manually, or turn the gate off with /codex:setup --disable-review-gate.";
const CHANGED_DURING_REVIEW =
  "The working tree changed during the stop-time Codex review, so the review does not cover what is there now. If a background task is writing to the workspace, wait for it to finish, then stop again.";

// --------------------------------------------------------------- planning

// Why a review cannot cover everything since the expected baseline:
// approved-lost / start-lost: that recorded tree was pruned by gc;
// unrecorded: the session recorded no baseline here, so the base is HEAD.
export type BaseNote = "approved-lost" | "start-lost" | "unrecorded";

export type BaseChoice = { tree: string; note: BaseNote | null };

// The tree the change is measured from: the last approved snapshot, else the
// session's starting tree, else HEAD, else the empty tree. A recorded tree
// that is no longer in the object database (pruned by gc) is skipped. Every
// base short of a recorded one comes with a note for Codex and the user.
export function chooseBase(
  workspace: WorkspaceState,
  repo: { exists: (tree: string) => boolean; head: () => string | null; empty: () => string | null },
): BaseChoice | null {
  let lost: BaseNote | null = null;
  for (const [tree, note] of [
    [workspace.approvedTree, "approved-lost"],
    [workspace.startTree, "start-lost"],
  ] as const) {
    if (tree === undefined) {
      continue;
    }
    if (repo.exists(tree)) {
      return { tree, note: lost };
    }
    lost ??= note;
  }
  const fallback = repo.head() ?? repo.empty();
  return fallback === null ? null : { tree: fallback, note: lost ?? "unrecorded" };
}

export type ReviewScope =
  | { kind: "diff"; base: string; current: string }
  // Inside a repository without a snapshot: the base against the working tree.
  | { kind: "worktree"; base: string | null }
  | { kind: "outside-git" };

export type ReviewPlan =
  | { kind: "unchanged" }
  | {
      kind: "review";
      scope: ReviewScope;
      // The snapshot under review, checked again after Codex answers.
      current: string | null;
      // Whether an allow may record `current` as approved.
      approvable: boolean;
      // Submodules whose contents the review must check by hand.
      submodules: string[];
      baseNote: BaseNote | null;
    };

export function planReview(snapshot: Snapshot, approvedTree: string | undefined, base: BaseChoice | null): ReviewPlan {
  const baseNote = base?.note ?? null;
  if (snapshot.kind === "not-git") {
    return {
      kind: "review",
      scope: { kind: "outside-git" },
      current: null,
      approvable: false,
      submodules: [],
      baseNote: null,
    };
  }
  if (snapshot.kind === "failed" || base === null) {
    return {
      kind: "review",
      scope: { kind: "worktree", base: base?.tree ?? null },
      current: null,
      approvable: false,
      submodules: snapshot.kind === "failed" ? snapshot.submodules : [],
      baseNote,
    };
  }
  const { tree } = snapshot;
  if (tree === approvedTree) {
    return { kind: "unchanged" };
  }
  return {
    kind: "review",
    scope: { kind: "diff", base: base.tree, current: tree },
    current: tree,
    approvable: true,
    submodules: [],
    baseNote,
  };
}

// ----------------------------------------------------------------- prompt

// Keeps text from the repository or from Claude from closing a data block
// of the prompt: no "<" survives.
export function encodeData(message: string): string {
  return message.replaceAll("<", "&lt;");
}

function treeId(value: string): string {
  if (!isTreeId(value)) {
    throw new Error(`not a tree id: ${JSON.stringify(value)}`);
  }
  return value;
}

const BASE_NOTES: Readonly<Record<BaseNote, string>> = {
  "approved-lost":
    "The previously approved baseline is no longer in the repository, so this review covers only the changes since an older baseline or HEAD.",
  "start-lost":
    "The tree this session started from is no longer in the repository, so this review covers only the changes since HEAD.",
  unrecorded:
    "No baseline was recorded for this workspace in this session, so this review covers only the changes since HEAD; commits before HEAD are not reviewed.",
};

function baseNoteText(note: BaseNote): string {
  return BASE_NOTES[note];
}

function scopeText(plan: Extract<ReviewPlan, { kind: "review" }>): string {
  const lines: string[] = [];
  const { scope } = plan;
  if (scope.kind === "diff") {
    const range = `${treeId(scope.base)} ${treeId(scope.current)}`;
    lines.push(
      `Review the change between two Git tree ids: the base ${treeId(scope.base)} and the current working tree ${treeId(scope.current)}.`,
      `Inspect it with \`git diff --stat ${range}\` and \`git diff ${range}\`, and read files where you need more context.`,
      "The current tree includes untracked files but not ignored ones.",
    );
  } else if (scope.kind === "worktree" && scope.base !== null) {
    lines.push(
      "A snapshot of the working tree could not be taken, so review the working tree directly.",
      `Review \`git diff ${treeId(scope.base)}\` (the base tree ${treeId(scope.base)} against the working tree) and the untracked files listed by \`git ls-files --others --exclude-standard\`.`,
    );
  } else if (scope.kind === "worktree") {
    lines.push("Review all uncommitted changes: `git status`, `git diff HEAD`, and the untracked files.");
  } else {
    lines.push(
      "The workspace is not a Git repository, so there is no diff.",
      "Work out what changed from Claude's final message and check what you can by reading those files.",
    );
  }
  if (plan.baseNote !== null) {
    lines.push(baseNoteText(plan.baseNote));
  }
  if (plan.submodules.length > 0) {
    lines.push(
      `The repository has submodules: ${plan.submodules.map((sub) => encodeData(JSON.stringify(sub))).join(", ")}.`,
      "The diff above shows only each submodule's commit, so also review the uncommitted changes inside them (for example `git -C <path> status` and `git -C <path> diff`).",
    );
  }
  return lines.join("\n");
}

export function buildPrompt(plan: Extract<ReviewPlan, { kind: "review" }>, finalMessage: string): string {
  const template = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "stop-review-gate.md"), "utf8");
  return interpolate(template, {
    REVIEW_SCOPE: scopeText(plan),
    CLAUDE_FINAL_MESSAGE: finalMessage ? encodeData(finalMessage) : "(no message)",
  });
}

// --------------------------------------------------------------- decision

export type ReviewOutcome =
  | { kind: "failed"; reason: string }
  // after: a snapshot taken once Codex answered, when the review had one.
  | { kind: "answered"; output: StopGateOutput; after: Snapshot | null };

export type HookResponse = { block?: string; systemMessage?: string };

// blocks: the new consecutive-block count, or null to keep it. approve: the
// tree to record as approved, or null.
export type Decision = { response: HookResponse; blocks: number | null; approve: string | null };

// Turns a finished gate run into an outcome. Every failure, including Codex
// processes that could not be stopped, is a "failed" outcome.
export function outcomeFor(result: CodexRunResult, readOutput: () => string): ReviewOutcome {
  if (result.reapError !== null) {
    return { kind: "failed", reason: `The stop-time Codex review could not stop Codex: ${result.reapError}` };
  }
  if (result.timedOut) {
    return { kind: "failed", reason: "The stop-time Codex review timed out after 13 minutes." };
  }
  if (result.exitCode !== 0) {
    const reason = failureReason(result);
    return {
      kind: "failed",
      reason: `The stop-time Codex review failed (exit ${String(result.exitCode)})${reason ? `: ${reason}` : ""}.`,
    };
  }
  let raw = "";
  try {
    raw = readOutput();
  } catch {
    raw = "";
  }
  raw = raw.trim() ? raw : (result.lastAgentMessage ?? "");
  if (!raw.trim()) {
    return { kind: "failed", reason: "The stop-time Codex review returned no output." };
  }
  const parsed = parseStopGateOutput(raw);
  return parsed.ok
    ? { kind: "answered", output: parsed.output, after: null }
    : { kind: "failed", reason: `The stop-time Codex review returned an invalid verdict (${parsed.error}).` };
}

// blocks is null when the session has no usable state; then every block
// stands and there is no limit.
export function decide(
  plan: Extract<ReviewPlan, { kind: "review" }>,
  outcome: ReviewOutcome,
  blocks: number | null,
): Decision {
  const note = plan.baseNote === null ? undefined : baseNoteText(plan.baseNote);
  const withNote = (response: HookResponse): HookResponse => {
    const messages = [response.systemMessage, note].filter((text) => text !== undefined);
    return messages.length > 0 ? { ...response, systemMessage: capReason(messages.join("\n\n")) } : response;
  };

  if (outcome.kind === "failed") {
    return {
      response: withNote({ block: capReason(`${outcome.reason} ${FAILURE_HINT}`) }),
      blocks: null,
      approve: null,
    };
  }
  // A verdict on a tree that is no longer there decides nothing, not even at
  // the block limit, and does not count toward it.
  if (plan.current !== null) {
    const after = outcome.after;
    if (after?.kind !== "tree" || after.tree !== plan.current) {
      return { response: withNote({ block: CHANGED_DURING_REVIEW }), blocks: null, approve: null };
    }
  }
  const { output } = outcome;
  if (output.verdict === "block") {
    const findings = formatFindings(output);
    const count = blocks === null ? null : blocks + 1;
    if (count === null || count <= MAX_BLOCKS) {
      return {
        response: withNote({
          block: capReason(`Codex stop-time review found issues to fix before stopping:\n${findings}`),
        }),
        blocks: count,
        approve: null,
      };
    }
    return {
      response: withNote({
        systemMessage: capReason(
          `Codex blocked the stop ${count} times in a row, so the review gate reached its limit and let Claude stop. Run /codex:review manually. Codex's findings:\n${findings}`,
        ),
      }),
      blocks: 0,
      approve: null,
    };
  }
  return { response: withNote({}), blocks: 0, approve: plan.approvable ? plan.current : null };
}

// The hook's stdout: nothing to let Claude stop silently, otherwise one JSON
// object with a block decision and/or a message for the user.
export function formatResponse(response: HookResponse): string {
  const output: Record<string, string> = {};
  if (response.block !== undefined) {
    output.decision = "block";
    output.reason = response.block;
  }
  if (response.systemMessage !== undefined) {
    output.systemMessage = response.systemMessage;
  }
  return Object.keys(output).length > 0 ? `${JSON.stringify(output)}\n` : "";
}

// ------------------------------------------------------------------- main

function parseInput(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

type RunResult = { kind: "outcome"; outcome: ReviewOutcome } | { kind: "exit"; code: number; message?: string };

async function runReview(cwd: string, prompt: string): Promise<RunResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-gate-"));
  try {
    const outputFile = path.join(dir, "last.json");
    const args = [
      "exec",
      "-s",
      "read-only",
      ...APPROVAL_OVERRIDES,
      "--skip-git-repo-check",
      "--ephemeral",
      "--output-schema",
      path.join(PLUGIN_ROOT, "schemas", "stop-gate.schema.json"),
      "--json",
      "-o",
      outputFile,
      "-",
    ];
    const result = await runCodex(args, { cwd, stdin: prompt, timeoutMs: GATE_TIMEOUT_MS });
    if (result.receivedSignal && result.reapError === null) {
      return { kind: "exit", code: signalExitCode(result.receivedSignal) };
    }
    return { kind: "outcome", outcome: outcomeFor(result, () => fs.readFileSync(outputFile, "utf8")) };
  } catch (error) {
    if (error instanceof CodexNotFoundError) {
      return {
        kind: "exit",
        code: 0,
        message: "Codex is not installed, so the review gate was skipped. Run /codex:setup.",
      };
    }
    throw error;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const input = parseInput(await readStdin());
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = resolveWorkspaceRoot(cwd);
  if (!isReviewGateEnabled(root)) {
    return 0;
  }

  // Without a usable session id there is no state: every stop is reviewed
  // and there is no block limit.
  const sessionId = safeSessionId(input.session_id);
  const state = sessionId === null ? null : readGateState(sessionId);
  const key = workspaceKey(root);
  const workspace = state?.workspaces[key] ?? {};
  const save = (blocks: number | null, approve: string | null): void => {
    if (sessionId === null || state === null || (blocks === null && approve === null)) {
      return;
    }
    if (approve !== null) {
      state.workspaces[key] = { ...workspace, approvedTree: approve };
    }
    if (blocks !== null) {
      state.blocks = blocks;
    }
    writeGateState(sessionId, state);
  };

  const snapshot = takeSnapshot(root);
  const base =
    snapshot.kind === "not-git"
      ? null
      : chooseBase(workspace, {
          exists: (tree) => treeExists(root, tree),
          head: () => headTree(root),
          empty: () => emptyTree(root),
        });
  const plan = planReview(snapshot, workspace.approvedTree, base);
  if (plan.kind === "unchanged") {
    if (state !== null && state.blocks !== 0) {
      save(0, null);
    }
    return 0;
  }

  const lastMessage = typeof input.last_assistant_message === "string" ? input.last_assistant_message.trim() : "";
  // Inside Git, Codex runs at the root so the commands the prompt names see
  // the whole repository.
  const codexCwd = snapshot.kind === "not-git" ? cwd : root;
  const run = await runReview(codexCwd, buildPrompt(plan, lastMessage));
  if (run.kind === "exit") {
    if (run.message !== undefined) {
      // Codex is missing and Claude stops, which ends the run of blocks.
      if (state !== null && state.blocks !== 0) {
        save(0, null);
      }
      process.stdout.write(formatResponse({ systemMessage: run.message }));
    }
    return run.code;
  }
  let outcome = run.outcome;
  if (outcome.kind === "answered" && plan.current !== null) {
    outcome = { ...outcome, after: takeSnapshot(root) };
  }
  const decision = decide(plan, outcome, state === null ? null : state.blocks);
  save(decision.blocks, decision.approve);
  process.stdout.write(formatResponse(decision.response));
  return 0;
}

// Runs only as the hook command, not when a test imports the functions above.
if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    // A crash must not end the turn silently while the gate is on.
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      formatResponse({ block: capReason(`The stop-time Codex review crashed: ${message}. ${FAILURE_HINT}`) }),
    );
  }
}
