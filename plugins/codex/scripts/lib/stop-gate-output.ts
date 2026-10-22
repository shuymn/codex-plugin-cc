// Validates the stop-gate verdict against every constraint of
// schemas/stop-gate.schema.json, plus one rule the schema cannot express: a
// block must name at least one finding. Written for that one schema rather
// than as a general JSON Schema implementation.

import { checkEnum, checkKeys, checkPositiveInteger, checkString, isRecord } from "./json.ts";

const VERDICTS = ["allow", "block"] as const;
const TOP_LEVEL_KEYS = ["verdict", "summary", "findings"];
const FINDING_KEYS = ["file", "line", "problem", "fix"];

// Claude Code shows the reason to Claude; keep it bounded.
export const MAX_REASON_CHARS = 8000;
const TRUNCATED = "\n[truncated]";

export type StopGateFinding = { file: string; line: number; problem: string; fix: string };

export type StopGateOutput = {
  verdict: (typeof VERDICTS)[number];
  summary: string;
  findings: StopGateFinding[];
};

export type ParsedStopGateOutput = { ok: true; output: StopGateOutput } | { ok: false; error: string };

function checkFinding(finding: unknown, where: string): string | null {
  if (!isRecord(finding)) {
    return `${where}: expected an object`;
  }
  return (
    checkKeys(finding, FINDING_KEYS, where) ??
    checkString(finding.file, `${where}.file`, 1) ??
    checkPositiveInteger(finding.line, `${where}.line`) ??
    checkString(finding.problem, `${where}.problem`, 1) ??
    checkString(finding.fix, `${where}.fix`, 0)
  );
}

export function validateStopGateOutput(data: unknown): string | null {
  if (!isRecord(data)) {
    return "output: expected a JSON object";
  }
  const shapeError =
    checkKeys(data, TOP_LEVEL_KEYS, "output") ??
    checkEnum(data.verdict, VERDICTS, "verdict") ??
    checkString(data.summary, "summary", 1);
  if (shapeError) {
    return shapeError;
  }
  if (!Array.isArray(data.findings)) {
    return "findings: expected an array";
  }
  for (const [index, finding] of data.findings.entries()) {
    const error = checkFinding(finding, `findings[${index}]`);
    if (error) {
      return error;
    }
  }
  if (data.verdict === "block" && data.findings.length === 0) {
    return "findings: a block needs at least one finding";
  }
  return null;
}

// The validator above has checked every property, so a null error means the
// data has the StopGateOutput shape.
function isStopGateOutput(_data: unknown, error: string | null): _data is StopGateOutput {
  return error === null;
}

export function parseStopGateOutput(raw: string): ParsedStopGateOutput {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const error = validateStopGateOutput(data);
  return isStopGateOutput(data, error) ? { ok: true, output: data } : { ok: false, error: error ?? "invalid output" };
}

// Cuts a hook reason or message to MAX_REASON_CHARS.
export function capReason(text: string): string {
  return text.length <= MAX_REASON_CHARS ? text : `${text.slice(0, MAX_REASON_CHARS - TRUNCATED.length)}${TRUNCATED}`;
}

// The summary and every finding, one finding per line.
export function formatFindings(output: StopGateOutput): string {
  const lines = [output.summary];
  for (const finding of output.findings) {
    lines.push(`- ${finding.file}:${finding.line}: ${finding.problem}`);
    if (finding.fix.trim()) {
      lines.push(`  Fix: ${finding.fix}`);
    }
  }
  return lines.join("\n");
}
