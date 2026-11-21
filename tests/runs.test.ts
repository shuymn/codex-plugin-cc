import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { pruneRunDirs } from "../plugins/codex/scripts/lib/runs.ts";
import { makeTempDir } from "./helpers.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

test("pruning removes only real run-id directories older than 7 days", () => {
  const stateHome = makeTempDir();
  const runs = path.join(stateHome, "codex-plugin-cc", "runs");
  fs.mkdirSync(runs, { recursive: true });
  const now = Date.now();
  const old = new Date(now - 8 * DAY_MS);
  const make = (name: string, age: Date): string => {
    const dir = path.join(runs, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "result.md"), "x");
    fs.utimesSync(dir, age, age);
    return dir;
  };
  const expired = make("20260101T000000Z-0123abcd", old);
  const recent = make("20260102T000000Z-0123abcd", new Date(now - 6 * DAY_MS));
  const otherName = make("keep-me", old);
  const oldFile = path.join(runs, "20260103T000000Z-0123abcd");
  fs.writeFileSync(oldFile, "not a directory");
  fs.utimesSync(oldFile, old, old);
  // A symlink named like a run id, to an old directory outside runs/.
  const target = path.join(makeTempDir(), "target");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "precious"), "x");
  fs.utimesSync(target, old, old);
  const link = path.join(runs, "20260104T000000Z-0123abcd");
  fs.symlinkSync(target, link);
  fs.lutimesSync(link, old, old);

  const saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  try {
    pruneRunDirs(now);
  } finally {
    if (saved === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = saved;
    }
  }

  assert.equal(fs.existsSync(expired), false);
  for (const kept of [recent, otherName, oldFile, link]) {
    assert.ok(fs.lstatSync(kept), kept);
  }
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(target, "precious")));
});
