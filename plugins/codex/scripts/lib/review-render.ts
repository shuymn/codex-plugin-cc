// Validates adversarial-review output against every constraint of
// schemas/review-output.schema.json, then renders it. The validator is written
// for that one schema rather than as a general JSON Schema implementation.

import { checkEnum, checkKeys, checkPositiveInteger, checkString, isRecord } from "./json.ts";

const VERDICTS = ["approve", "needs-attention"] as const;
const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const TOP_LEVEL_KEYS = ["verdict", "summary", "findings", "next_steps"];
const FINDING_KEYS = ["severity", "title", "body", "file", "line_start", "line_end", "confidence", "recommendation"];

type Severity = (typeof SEVERITIES)[number];

export type ReviewFinding = {
  severity: Severity;
  title: string;
  body: string;
  file: string;
  line_start: number;
  line_end: number;
  confidence: number;
  recommendation: string;
};

export type ReviewOutput = {
  verdict: (typeof VERDICTS)[number];
  summary: string;
  findings: ReviewFinding[];
  next_steps: string[];
};

export type ParsedReview = { ok: true; review: ReviewOutput } | { ok: false; error: string };

function checkFinding(finding: unknown, where: string): string | null {
  if (!isRecord(finding)) {
    return `${where}: expected an object`;
  }
  const confidence = finding.confidence;
  return (
    checkKeys(finding, FINDING_KEYS, where) ??
    checkEnum(finding.severity, SEVERITIES, `${where}.severity`) ??
    checkString(finding.title, `${where}.title`, 1) ??
    checkString(finding.body, `${where}.body`, 1) ??
    checkString(finding.file, `${where}.file`, 1) ??
    checkPositiveInteger(finding.line_start, `${where}.line_start`) ??
    checkPositiveInteger(finding.line_end, `${where}.line_end`) ??
    (typeof confidence === "number" && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
      ? null
      : `${where}.confidence: expected a number from 0 to 1`) ??
    checkString(finding.recommendation, `${where}.recommendation`, 0)
  );
}

export function validateReviewOutput(data: unknown): string | null {
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
  if (!Array.isArray(data.next_steps)) {
    return "next_steps: expected an array";
  }
  for (const [index, step] of data.next_steps.entries()) {
    const error = checkString(step, `next_steps[${index}]`, 1);
    if (error) {
      return error;
    }
  }
  return null;
}

// The validator above has checked every property, so a null error means the
// data has the ReviewOutput shape.
function isReviewOutput(_data: unknown, error: string | null): _data is ReviewOutput {
  return error === null;
}

export function parseReviewOutput(raw: string): ParsedReview {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const error = validateReviewOutput(data);
  return isReviewOutput(data, error) ? { ok: true, review: data } : { ok: false, error: error ?? "invalid output" };
}

function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

function formatLineRange(finding: ReviewFinding): string {
  return finding.line_end === finding.line_start
    ? `:${finding.line_start}`
    : `:${finding.line_start}-${finding.line_end}`;
}

export function renderReviewResult(review: ReviewOutput, meta: { title: string; targetLabel: string }): string {
  const findings = review.findings.toSorted(
    (left, right) => severityRank(left.severity) - severityRank(right.severity),
  );
  const lines = [
    `# ${meta.title}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${review.verdict}`,
    "",
    review.summary,
    "",
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      lines.push(
        `- [${finding.severity}] ${finding.title} (${finding.file}${formatLineRange(finding)}) confidence ${finding.confidence}`,
        `  ${finding.body}`,
      );
      if (finding.recommendation.trim()) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (review.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of review.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
