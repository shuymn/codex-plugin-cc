// The scratch directory a write-capable run gives Codex as TMPDIR. Only the
// directory this module created is ever deleted: it is identified by the path
// mkdtemp returned together with its device and inode, and is deleted only
// while that path is still the same real directory.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Scratch = { path: string; dev: number; ino: number };

export function createScratch(): Scratch {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-run-scratch-"));
  const stat = fs.lstatSync(dir);
  return { path: dir, dev: stat.dev, ino: stat.ino };
}

// Returns true when the directory is gone (deleted here, or already removed by
// Codex), false when it is left behind: deletion failed, or the path no longer
// names the directory that was created, so it is not touched.
export function removeScratch(scratch: Scratch): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(scratch.path);
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
  if (!stat.isDirectory() || stat.dev !== scratch.dev || stat.ino !== scratch.ino) {
    return false;
  }
  try {
    // rmSync removes symlinks inside the directory without following them.
    fs.rmSync(scratch.path, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
