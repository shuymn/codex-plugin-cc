import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { UsageError } from "./args.ts";
import { CodexNotFoundError, cleanCodexStderr } from "./codex-exec.ts";
import { TRANSCRIPT_PATH_ENV } from "./env.ts";
import { isRecord } from "./json.ts";

const IMPORT_COMPLETED = "externalAgentConfig/import/completed";
const IMPORT_TIMEOUT_MS = 120_000;
const METHOD_NOT_FOUND = -32601;

// Hand-written subset of the app-server protocol this client uses.
type JsonRpcId = number | string;
type JsonRpcError = { code: number; message: string };
type JsonRpcMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
};

export class TransferError extends Error {
  override name = "TransferError";
  rpcCode: number | null = null;
}

function toMessage(value: unknown): JsonRpcMessage | null {
  if (!isRecord(value)) {
    return null;
  }
  const message: JsonRpcMessage = {};
  if (typeof value.id === "number" || typeof value.id === "string") {
    message.id = value.id;
  }
  if (typeof value.method === "string") {
    message.method = value.method;
  }
  if ("params" in value) {
    message.params = value.params;
  }
  if ("result" in value) {
    message.result = value.result;
  }
  if (isRecord(value.error)) {
    message.error = {
      code: typeof value.error.code === "number" ? value.error.code : 0,
      message: typeof value.error.message === "string" ? value.error.message : "unknown error",
    };
  }
  return message;
}

function importIdOf(value: unknown): string | null {
  return isRecord(value) && typeof value.importId === "string" ? value.importId : null;
}

function claudeProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

function resolveUserPath(cwd: string, value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(cwd, value);
}

// Accepts only a .jsonl transcript that really lives under ~/.claude/projects.
export function resolveClaudeSessionPath(cwd: string, source: string | undefined): string {
  const requested = source ?? process.env[TRANSCRIPT_PATH_ENV];
  if (!requested) {
    throw new UsageError(
      "could not identify the current Claude transcript. Retry with --source <path-to-claude-jsonl>.",
    );
  }
  const sourcePath = resolveUserPath(cwd, requested);
  if (path.extname(sourcePath) !== ".jsonl") {
    throw new UsageError(`the Claude session source must be a .jsonl file: ${sourcePath}`);
  }
  let resolved: string;
  let projects: string;
  try {
    resolved = fs.realpathSync(sourcePath);
    projects = fs.realpathSync(claudeProjectsDir());
  } catch {
    throw new UsageError(`Claude session file not found: ${sourcePath}`);
  }
  const relative = path.relative(projects, resolved);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new UsageError(`Codex can import Claude sessions only from ${claudeProjectsDir()}: ${resolved}`);
  }
  return resolved;
}

function codexHome(): string {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

// Codex records each import in a ledger keyed by source path and content hash.
function importedThreadIdForSource(sourcePath: string): string | null {
  let records: unknown[];
  try {
    const ledger: unknown = JSON.parse(
      fs.readFileSync(path.join(codexHome(), "external_agent_session_imports.json"), "utf8"),
    );
    records = isRecord(ledger) && Array.isArray(ledger.records) ? ledger.records : [];
  } catch {
    return null;
  }
  const contentSha256 = createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
  let threadId: string | null = null;
  for (const record of records) {
    if (
      isRecord(record) &&
      record.source_path === sourcePath &&
      record.content_sha256 === contentSha256 &&
      typeof record.imported_thread_id === "string"
    ) {
      threadId = record.imported_thread_id;
    }
  }
  return threadId;
}

function sessionMigration(sourcePath: string, cwd: string) {
  return {
    migrationItems: [
      {
        itemType: "SESSIONS",
        description: `Transfer Claude session ${path.basename(sourcePath)}`,
        cwd: null,
        details: {
          plugins: [],
          sessions: [{ path: sourcePath, cwd, title: null }],
          mcpServers: [],
          hooks: [],
          subagents: [],
          commands: [],
        },
      },
    ],
  };
}

// Speaks newline-delimited JSON-RPC to `codex app-server` over stdio:
// initialize, initialized, externalAgentConfig/import, then waits for the
// import/completed notification with the same importId.
export async function importClaudeSession(cwd: string, sourcePath: string): Promise<string> {
  const child = spawn("codex", ["app-server"], { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-1_000_000);
  });
  child.stdin.on("error", () => {});

  // Set once the server can no longer answer; every waiter fails with it.
  let closedError: Error | null = null;
  const pending = new Map<JsonRpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  // Completions are recorded from the first line on, so one that arrives
  // right after the import response is never missed.
  const completedImportIds = new Set<string>();
  let onCompletion: (() => void) | null = null;

  const close = (error: Error): void => {
    closedError ??= error;
    for (const entry of pending.values()) {
      entry.reject(closedError);
    }
    pending.clear();
    onCompletion?.();
  };
  const exited = new Promise<void>((resolve) => {
    child.on("error", (error) => {
      const notFound = "code" in error && error.code === "ENOENT";
      close(notFound ? new CodexNotFoundError("codex was not found on PATH.") : error);
      resolve();
    });
    child.on("close", () => {
      close(
        new TransferError(
          `codex app-server exited before the import finished.${stderr ? `\n${cleanCodexStderr(stderr)}` : ""}`,
        ),
      );
      resolve();
    });
  });

  const send = (message: JsonRpcMessage): void => {
    if (closedError === null) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  };

  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message: JsonRpcMessage | null;
    try {
      const parsed: unknown = JSON.parse(line);
      message = toMessage(parsed);
    } catch {
      return;
    }
    if (message === null) {
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      // This client implements no server-to-client requests.
      send({ id: message.id, error: { code: METHOD_NOT_FOUND, message: `unsupported request ${message.method}` } });
      return;
    }
    if (message.method === IMPORT_COMPLETED) {
      const importId = importIdOf(message.params);
      if (importId !== null) {
        completedImportIds.add(importId);
        onCompletion?.();
      }
      return;
    }
    if (message.id === undefined || message.method !== undefined) {
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      const error = new TransferError(message.error.message);
      error.rpcCode = message.error.code;
      entry.reject(error);
    } else {
      entry.resolve(message.result);
    }
  });

  let nextId = 1;
  const request = (method: string, params: unknown): Promise<unknown> =>
    new Promise<unknown>((resolve, reject) => {
      if (closedError) {
        reject(closedError);
        return;
      }
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });

  let timeout: NodeJS.Timeout | undefined;
  try {
    await request("initialize", {
      clientInfo: { name: "codex-plugin-cc", title: "Codex plugin for Claude Code", version: "2" },
      capabilities: { experimentalApi: false },
    });
    send({ method: "initialized" });

    let response: unknown;
    try {
      response = await request("externalAgentConfig/import", sessionMigration(sourcePath, cwd));
    } catch (error) {
      if (error instanceof TransferError && error.rpcCode === METHOD_NOT_FOUND) {
        throw new TransferError(
          "this Codex version cannot import Claude sessions. Update Codex with `npm install -g @openai/codex@latest`, then retry.",
          { cause: error },
        );
      }
      throw error;
    }
    const importId = importIdOf(response);
    if (importId === null) {
      throw new TransferError("codex app-server returned no importId for the import request.");
    }
    await new Promise<void>((resolve, reject) => {
      onCompletion = () => {
        if (completedImportIds.has(importId)) {
          resolve();
        } else if (closedError) {
          reject(closedError);
        }
      };
      timeout = setTimeout(
        () => reject(new TransferError("timed out waiting for Codex to finish importing the Claude session.")),
        IMPORT_TIMEOUT_MS,
      );
      onCompletion();
    });
  } finally {
    clearTimeout(timeout);
    onCompletion = null;
    // Closing stdin ends the app-server; reap it on every path.
    child.stdin.end();
    const killTimer = setTimeout(() => child.kill("SIGTERM"), 5_000);
    await exited;
    clearTimeout(killTimer);
    lines.close();
  }

  const threadId = importedThreadIdForSource(sourcePath);
  if (!threadId) {
    throw new TransferError(
      `Codex reported that the import completed, but did not record an imported thread.${stderr ? `\n${cleanCodexStderr(stderr)}` : ""}`,
    );
  }
  return threadId;
}
