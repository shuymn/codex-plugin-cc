import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  readGateState,
  recordStartTree,
  workspaceKey,
  writeGateState,
} from "../plugins/codex/scripts/lib/stop-gate-state.ts";
import { makeTempDir } from "./helpers.ts";

const TREE_A = "a".repeat(40);
const TREE_B = "b".repeat(40);

function useDataDir(): string {
  const dir = makeTempDir();
  process.env.CLAUDE_PLUGIN_DATA = dir;
  return dir;
}

test("a missing state is empty, and a written state reads back", () => {
  useDataDir();
  const root = makeTempDir();
  assert.deepEqual(readGateState("s1"), { workspaces: {}, blocks: 0 });
  writeGateState("s1", { workspaces: { [workspaceKey(root)]: { approvedTree: TREE_A } }, blocks: 2 });
  assert.deepEqual(readGateState("s1"), { workspaces: { [workspaceKey(root)]: { approvedTree: TREE_A } }, blocks: 2 });
  assert.deepEqual(readGateState("s2"), { workspaces: {}, blocks: 0 });
});

test("the state lives in stop-gate/<session_id>.json under the plugin data dir", () => {
  const dir = useDataDir();
  writeGateState("abc-1", { workspaces: {}, blocks: 1 });
  assert.ok(fs.existsSync(path.join(dir, "stop-gate", "abc-1.json")));
});

test("values that are not tree ids or counts are dropped on read", () => {
  const dir = useDataDir();
  fs.mkdirSync(path.join(dir, "stop-gate"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "stop-gate", "s1.json"),
    JSON.stringify({
      workspaces: { "/w": { approvedTree: "--help", startTree: TREE_B }, "/x": "nope" },
      blocks: -1,
    }),
  );
  assert.deepEqual(readGateState("s1"), { workspaces: { "/w": { startTree: TREE_B } }, blocks: 0 });
  fs.writeFileSync(path.join(dir, "stop-gate", "s1.json"), "{ not json");
  assert.deepEqual(readGateState("s1"), { workspaces: {}, blocks: 0 });
});

test("recordStartTree keeps the first tree a session saw", () => {
  useDataDir();
  const root = makeTempDir();
  recordStartTree("s1", root, TREE_A);
  recordStartTree("s1", root, TREE_B);
  assert.equal(readGateState("s1").workspaces[workspaceKey(root)]?.startTree, TREE_A);
});
