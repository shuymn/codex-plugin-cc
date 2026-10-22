import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The SessionStart hook exports these into CLAUDE_ENV_FILE so later Bash calls
// from the same Claude session can see them.
export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
export const TRANSCRIPT_PATH_ENV = "CODEX_COMPANION_TRANSCRIPT_PATH";
export const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

export const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..", "..");

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function pluginDataDir(): string {
  const configured = process.env[PLUGIN_DATA_ENV];
  return configured ? path.resolve(configured) : path.join(os.tmpdir(), "codex-plugin-cc");
}

// Returns null when the id is missing or not safe to use as a file name.
export function safeSessionId(value: unknown): string | null {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value) ? value : null;
}

export function currentSessionId(): string | null {
  return safeSessionId(process.env[SESSION_ID_ENV]);
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function appendEnvVar(name: string, value: unknown): void {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile || typeof value !== "string" || value === "") {
    return;
  }
  fs.appendFileSync(envFile, `export ${name}=${shellEscape(value)}\n`, "utf8");
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
