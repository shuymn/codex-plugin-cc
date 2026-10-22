// Per-session state of the stop-time review gate, in
// <plugin data>/stop-gate/<session_id>.json:
//   {"workspaces": {"<realpath of root>": {"approvedTree": "<tree>", "startTree": "<tree>"}}, "blocks": 0}
// approvedTree: the last working-tree snapshot Codex allowed.
// startTree: the HEAD tree when the session started.
// blocks: consecutive stops Codex blocked with findings.
// Callers pass a session id already checked with safeSessionId.

import fs from "node:fs";
import path from "node:path";

import { pluginDataDir, writeFileAtomic } from "./env.ts";
import { canonicalWorkspaceRoot } from "./git.ts";
import { isRecord } from "./json.ts";
import { isTreeId } from "./snapshot.ts";

export type WorkspaceState = { approvedTree?: string; startTree?: string };
export type GateState = { workspaces: Record<string, WorkspaceState>; blocks: number };

function statePath(sessionId: string): string {
  return path.join(pluginDataDir(), "stop-gate", `${sessionId}.json`);
}

export function workspaceKey(root: string): string {
  return canonicalWorkspaceRoot(root);
}

function readWorkspace(value: unknown): WorkspaceState | null {
  if (!isRecord(value)) {
    return null;
  }
  const workspace: WorkspaceState = {};
  if (isTreeId(value.approvedTree)) {
    workspace.approvedTree = value.approvedTree;
  }
  if (isTreeId(value.startTree)) {
    workspace.startTree = value.startTree;
  }
  return workspace;
}

// A missing or unreadable file, and any value of the wrong form, reads as empty.
export function readGateState(sessionId: string): GateState {
  const state: GateState = { workspaces: {}, blocks: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath(sessionId), "utf8"));
  } catch {
    return state;
  }
  if (!isRecord(parsed)) {
    return state;
  }
  if (isRecord(parsed.workspaces)) {
    for (const [key, value] of Object.entries(parsed.workspaces)) {
      const workspace = readWorkspace(value);
      if (workspace) {
        state.workspaces[key] = workspace;
      }
    }
  }
  if (typeof parsed.blocks === "number" && Number.isInteger(parsed.blocks) && parsed.blocks >= 0) {
    state.blocks = parsed.blocks;
  }
  return state;
}

export function writeGateState(sessionId: string, state: GateState): void {
  writeFileAtomic(statePath(sessionId), `${JSON.stringify(state, null, 2)}\n`);
}

// Records the tree a session started from, unless an earlier start (before a
// resume or compaction) is already recorded.
export function recordStartTree(sessionId: string, root: string, tree: string): void {
  const state = readGateState(sessionId);
  const key = workspaceKey(root);
  const workspace = state.workspaces[key] ?? {};
  if (workspace.startTree !== undefined) {
    return;
  }
  state.workspaces[key] = { ...workspace, startTree: tree };
  writeGateState(sessionId, state);
}
