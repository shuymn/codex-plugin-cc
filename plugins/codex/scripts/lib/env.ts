import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Where the runner keeps its thread records, run directories, and run log:
// $XDG_STATE_HOME/codex-plugin-cc, or ~/.local/state/codex-plugin-cc when
// XDG_STATE_HOME is unset, empty, or relative (as the XDG spec says to treat it).
export function stateDir(): string {
  const configured = process.env.XDG_STATE_HOME;
  const base = configured && path.isAbsolute(configured) ? configured : path.join(os.homedir(), ".local", "state");
  return path.join(base, "codex-plugin-cc");
}

// Writes through a temporary file in the same directory and renames it, so a
// reader never sees a partial file.
export function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, content, "utf8");
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}
