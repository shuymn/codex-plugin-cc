// SessionStart: exports the Claude session id, transcript path, and plugin
// data directory through CLAUDE_ENV_FILE so the adapter can see them later.

import { readStdin } from "./lib/args.ts";
import { appendEnvVar, PLUGIN_DATA_ENV, SESSION_ID_ENV, TRANSCRIPT_PATH_ENV } from "./lib/env.ts";
import { isRecord } from "./lib/json.ts";

try {
  const raw = (await readStdin()).trim();
  const parsed: unknown = raw ? JSON.parse(raw) : {};
  const input = isRecord(parsed) ? parsed : {};
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
} catch (error) {
  process.stderr.write(`codex-plugin: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
