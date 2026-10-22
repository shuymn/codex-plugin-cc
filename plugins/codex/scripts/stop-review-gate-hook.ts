// Stop hook (interim version): when the review gate is on for the workspace,
// asks Codex for a read-only review of the previous Claude turn and blocks the
// stop unless Codex answers ALLOW. Any failure other than a missing codex
// blocks, so a broken gate is noticed instead of silently passing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readStdin } from "./lib/args.ts";
import { APPROVAL_OVERRIDES, CodexNotFoundError, failureReason, runCodex, signalExitCode } from "./lib/codex-exec.ts";
import { PLUGIN_ROOT } from "./lib/env.ts";
import { isReviewGateEnabled } from "./lib/gate-config.ts";
import { resolveWorkspaceRoot } from "./lib/git.ts";
import { isRecord } from "./lib/json.ts";

// hooks.json allows 15 minutes; stop earlier so the hook can still answer.
const GATE_TIMEOUT_MS = 13 * 60 * 1000;
const MANUAL_HINT = "Run /codex:review --wait manually, or disable the gate with /codex:setup --disable-review-gate.";

type Verdict = { allow: true } | { allow: false; reason: string };

function block(reason: string): Verdict {
  return { allow: false, reason };
}

function buildPrompt(lastAssistantMessage: string): string {
  const template = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "stop-review-gate.md"), "utf8");
  const responseBlock = lastAssistantMessage ? `Previous Claude response:\n${lastAssistantMessage}` : "";
  return template.replace("{{CLAUDE_RESPONSE_BLOCK}}", () => responseBlock);
}

function judge(output: string): Verdict {
  const text = output.trim();
  if (!text) {
    return block(`The stop-time Codex review returned no output. ${MANUAL_HINT}`);
  }
  const firstLine = (text.split(/\r?\n/, 1)[0] ?? "").trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { allow: true };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return block(`Codex stop-time review found issues to fix before stopping: ${reason}`);
  }
  return block(`The stop-time Codex review returned an unexpected answer. ${MANUAL_HINT}`);
}

function parseInput(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function main(): Promise<number> {
  const input = parseInput(await readStdin());
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!isReviewGateEnabled(resolveWorkspaceRoot(cwd))) {
    return 0;
  }

  const lastMessage = typeof input.last_assistant_message === "string" ? input.last_assistant_message.trim() : "";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-gate-"));
  let verdict: Verdict;
  try {
    const outputFile = path.join(dir, "last.md");
    const args = [
      "exec",
      "-s",
      "read-only",
      ...APPROVAL_OVERRIDES,
      "--skip-git-repo-check",
      "--ephemeral",
      "--json",
      "-o",
      outputFile,
      "-",
    ];
    const result = await runCodex(args, { cwd, stdin: buildPrompt(lastMessage), timeoutMs: GATE_TIMEOUT_MS });
    if (result.receivedSignal) {
      return signalExitCode(result.receivedSignal);
    }
    if (result.timedOut) {
      verdict = block(`The stop-time Codex review timed out after 13 minutes. ${MANUAL_HINT}`);
    } else if (result.exitCode !== 0) {
      const reason = failureReason(result);
      const detail = reason ? `: ${reason}` : "";
      verdict = block(`The stop-time Codex review failed (exit ${String(result.exitCode)})${detail}. ${MANUAL_HINT}`);
    } else {
      let output = "";
      try {
        output = fs.readFileSync(outputFile, "utf8");
      } catch {
        output = result.lastAgentMessage ?? "";
      }
      verdict = judge(output || result.lastAgentMessage || "");
    }
  } catch (error) {
    if (error instanceof CodexNotFoundError) {
      process.stderr.write("codex-plugin: Codex is not installed, so the review gate was skipped. Run /codex:setup.\n");
      return 0;
    }
    throw error;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (!verdict.allow) {
    process.stdout.write(`${JSON.stringify({ decision: "block", reason: verdict.reason })}\n`);
  }
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  // A crash must not end the turn silently while the gate is on.
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(
    `${JSON.stringify({ decision: "block", reason: `The stop-time Codex review crashed: ${message}. ${MANUAL_HINT}` })}\n`,
  );
}
