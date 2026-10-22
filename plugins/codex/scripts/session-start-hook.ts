// SessionStart: exports the Claude session id, transcript path, and plugin
// data directory through CLAUDE_ENV_FILE so the adapter can see them later.
// When the review gate is on for the workspace, also records the HEAD tree the
// session started from, so the first stop reviews commits made before it.

import { readStdin } from "./lib/args.ts";
import { appendEnvVar, PLUGIN_DATA_ENV, safeSessionId, SESSION_ID_ENV, TRANSCRIPT_PATH_ENV } from "./lib/env.ts";
import { isReviewGateEnabled } from "./lib/gate-config.ts";
import { resolveWorkspaceRoot } from "./lib/git.ts";
import { isRecord } from "./lib/json.ts";
import { sessionStartTree } from "./lib/snapshot.ts";
import { recordStartTree } from "./lib/stop-gate-state.ts";

function recordGateStart(input: Record<string, unknown>): void {
  const sessionId = safeSessionId(input.session_id);
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = resolveWorkspaceRoot(cwd);
  if (sessionId === null || !isReviewGateEnabled(root)) {
    return;
  }
  const tree = sessionStartTree(root);
  if (tree !== null) {
    recordStartTree(sessionId, root, tree);
  }
}

try {
  const raw = (await readStdin()).trim();
  const parsed: unknown = raw ? JSON.parse(raw) : {};
  const input = isRecord(parsed) ? parsed : {};
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
  recordGateStart(input);
} catch (error) {
  process.stderr.write(`codex-plugin: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
