import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  capReason,
  formatFindings,
  MAX_REASON_CHARS,
  parseStopGateOutput,
  validateStopGateOutput,
} from "../plugins/codex/scripts/lib/stop-gate-output.ts";
import { PLUGIN_ROOT } from "./helpers.ts";

function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { file: "src/a.ts", line: 3, problem: "Loses writes.", fix: "Write atomically.", ...overrides };
}

function output(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { verdict: "block", summary: "Needs a fix.", findings: [finding()], ...overrides };
}

function without(object: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...object };
  delete copy[key];
  return copy;
}

test("output that meets the schema is valid", () => {
  assert.equal(validateStopGateOutput(output()), null);
  assert.equal(validateStopGateOutput(output({ verdict: "allow", findings: [] })), null);
  assert.equal(validateStopGateOutput(output({ verdict: "allow" })), null);
  assert.equal(validateStopGateOutput(output({ findings: [finding({ fix: "" })] })), null);
});

test("the validator covers every property and enum the schema declares", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "stop-gate.schema.json"), "utf8")) as {
    required: string[];
    additionalProperties: boolean;
    properties: {
      verdict: { enum: string[] };
      findings: { items: { required: string[]; additionalProperties: boolean } };
    };
  };
  assert.deepEqual(Object.keys(output()).toSorted(), schema.required.toSorted());
  assert.deepEqual(Object.keys(finding()).toSorted(), schema.properties.findings.items.required.toSorted());
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.findings.items.additionalProperties, false);
  assert.deepEqual(schema.properties.verdict.enum.toSorted(), ["allow", "block"]);
});

const VIOLATIONS: [string, unknown, RegExp][] = [
  ["not an object", [], /expected a JSON object/],
  ["extra top-level property", output({ extra: 1 }), /unexpected property "extra"/],
  ["missing top-level property", without(output(), "summary"), /missing property "summary"/],
  ["extra finding property", output({ findings: [finding({ extra: 1 })] }), /findings\[0\]: unexpected property/],
  ["missing finding property", output({ findings: [without(finding(), "fix")] }), /missing property "fix"/],
  ["verdict enum", output({ verdict: "ALLOW" }), /verdict: expected one of/],
  ["empty summary", output({ summary: "" }), /summary: must not be empty/],
  ["findings type", output({ findings: {} }), /findings: expected an array/],
  ["empty file", output({ findings: [finding({ file: "" })] }), /file: must not be empty/],
  ["zero line", output({ findings: [finding({ line: 0 })] }), /line: expected an integer >= 1/],
  ["fractional line", output({ findings: [finding({ line: 2.5 })] }), /line: expected an integer >= 1/],
  ["empty problem", output({ findings: [finding({ problem: "" })] }), /problem: must not be empty/],
  ["fix type", output({ findings: [finding({ fix: null })] }), /fix: expected a string/],
  ["block without findings", output({ findings: [] }), /block needs at least one finding/],
];

for (const [name, data, expected] of VIOLATIONS) {
  test(`the validator rejects: ${name}`, () => {
    assert.match(validateStopGateOutput(data) ?? "", expected);
  });
}

test("parseStopGateOutput reports invalid JSON and accepts valid output", () => {
  const bad = parseStopGateOutput("ALLOW: looks fine");
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.error, /invalid JSON/);
  const good = parseStopGateOutput(JSON.stringify(output()));
  assert.ok(good.ok);
  assert.equal(good.output.verdict, "block");
});

test("formatFindings lists the summary and each finding with its location and fix", () => {
  const text = formatFindings({
    verdict: "block",
    summary: "Two problems.",
    findings: [
      { file: "a.ts", line: 3, problem: "P1", fix: "F1" },
      { file: "b.ts", line: 9, problem: "P2", fix: "" },
    ],
  });
  assert.equal(text, "Two problems.\n- a.ts:3: P1\n  Fix: F1\n- b.ts:9: P2");
});

test("capReason keeps short text and cuts long text to the limit", () => {
  assert.equal(capReason("short"), "short");
  const text = capReason("s".repeat(MAX_REASON_CHARS + 1));
  assert.equal(text.length, MAX_REASON_CHARS);
  assert.match(text, /\[truncated\]$/);
  assert.equal(capReason("x".repeat(MAX_REASON_CHARS)).length, MAX_REASON_CHARS);
});
