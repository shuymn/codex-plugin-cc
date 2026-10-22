import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  parseReviewOutput,
  renderReviewResult,
  validateReviewOutput,
} from "../plugins/codex/scripts/lib/review-render.ts";
import { PLUGIN_ROOT } from "./helpers.ts";

function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    severity: "high",
    title: "Title",
    body: "Body",
    file: "a.ts",
    line_start: 1,
    line_end: 2,
    confidence: 0.5,
    recommendation: "",
    ...overrides,
  };
}

function review(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { verdict: "approve", summary: "Fine.", findings: [finding()], next_steps: ["Ship."], ...overrides };
}

function without(object: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...object };
  delete copy[key];
  return copy;
}

test("a review that meets the schema is valid", () => {
  assert.equal(validateReviewOutput(review()), null);
  assert.equal(validateReviewOutput(review({ findings: [], next_steps: [] })), null);
  assert.equal(
    validateReviewOutput(review({ findings: [finding({ confidence: 0 }), finding({ confidence: 1 })] })),
    null,
  );
});

test("the validator covers every property and enum the schema declares", () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"), "utf8"),
  ) as {
    required: string[];
    additionalProperties: boolean;
    properties: {
      verdict: { enum: string[] };
      findings: {
        items: { required: string[]; additionalProperties: boolean; properties: { severity: { enum: string[] } } };
      };
    };
  };
  assert.deepEqual(Object.keys(review()).toSorted(), schema.required.toSorted());
  assert.deepEqual(Object.keys(finding()).toSorted(), schema.properties.findings.items.required.toSorted());
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.findings.items.additionalProperties, false);
  for (const verdict of schema.properties.verdict.enum) {
    assert.equal(validateReviewOutput(review({ verdict })), null);
  }
  for (const severity of schema.properties.findings.items.properties.severity.enum) {
    assert.equal(validateReviewOutput(review({ findings: [finding({ severity })] })), null);
  }
});

const VIOLATIONS: [string, unknown, RegExp][] = [
  ["not an object", [], /expected a JSON object/],
  ["extra top-level property", review({ extra: 1 }), /unexpected property "extra"/],
  ["missing top-level property", without(review(), "summary"), /missing property "summary"/],
  [
    "extra finding property",
    review({ findings: [finding({ extra: 1 })] }),
    /findings\[0\]: unexpected property "extra"/,
  ],
  [
    "missing finding property",
    review({ findings: [without(finding(), "file")] }),
    /findings\[0\]: missing property "file"/,
  ],
  ["verdict enum", review({ verdict: "maybe" }), /verdict: expected one of/],
  ["severity enum", review({ findings: [finding({ severity: "info" })] }), /severity: expected one of/],
  ["empty summary", review({ summary: "" }), /summary: must not be empty/],
  ["empty title", review({ findings: [finding({ title: "" })] }), /title: must not be empty/],
  ["empty body", review({ findings: [finding({ body: "" })] }), /body: must not be empty/],
  ["empty file", review({ findings: [finding({ file: "" })] }), /file: must not be empty/],
  ["zero line_start", review({ findings: [finding({ line_start: 0 })] }), /line_start: expected an integer >= 1/],
  ["fractional line_end", review({ findings: [finding({ line_end: 1.5 })] }), /line_end: expected an integer >= 1/],
  ["string line number", review({ findings: [finding({ line_start: "3" })] }), /line_start/],
  [
    "confidence above 1",
    review({ findings: [finding({ confidence: 1.2 })] }),
    /confidence: expected a number from 0 to 1/,
  ],
  ["negative confidence", review({ findings: [finding({ confidence: -0.1 })] }), /confidence/],
  ["recommendation type", review({ findings: [finding({ recommendation: 1 })] }), /recommendation: expected a string/],
  ["findings type", review({ findings: {} }), /findings: expected an array/],
  ["next_steps type", review({ next_steps: "x" }), /next_steps: expected an array/],
  ["next_steps item type", review({ next_steps: [1] }), /next_steps\[0\]: expected a string/],
  ["empty next step", review({ next_steps: [""] }), /next_steps\[0\]: must not be empty/],
];

for (const [name, data, expected] of VIOLATIONS) {
  test(`the validator rejects: ${name}`, () => {
    assert.match(validateReviewOutput(data) ?? "", expected);
  });
}

test("parseReviewOutput reports invalid JSON", () => {
  const parsed = parseReviewOutput("{ nope");
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.error, /invalid JSON/);
});

test("renderReviewResult orders findings by severity and keeps paths and lines", () => {
  const parsed = parseReviewOutput(
    JSON.stringify(
      review({
        verdict: "needs-attention",
        findings: [
          finding({ severity: "low", title: "Low", file: "z.ts", line_start: 7, line_end: 7 }),
          finding({ severity: "critical", title: "Critical", recommendation: "Fix it." }),
          finding({ severity: "medium", title: "Medium" }),
        ],
      }),
    ),
  );
  assert.ok(parsed.ok);
  const output = renderReviewResult(parsed.review, {
    title: "Codex Adversarial Review",
    targetLabel: "branch vs main",
  });
  assert.match(output, /^# Codex Adversarial Review\n\nTarget: branch vs main\nVerdict: needs-attention\n\nFine\.\n/);
  const order = ["Critical", "Medium", "Low"].map((title) => output.indexOf(`] ${title} (`));
  assert.deepEqual(
    order,
    order.toSorted((a, b) => a - b),
  );
  assert.match(output, /\(z\.ts:7\)/);
  assert.match(output, /\(a\.ts:1-2\)/);
  assert.match(output, /Recommendation: Fix it\./);
  assert.match(output, /Next steps:\n- Ship\.\n$/);
});

test("renderReviewResult says when there are no findings", () => {
  const parsed = parseReviewOutput(JSON.stringify(review({ findings: [], next_steps: [] })));
  assert.ok(parsed.ok);
  assert.match(renderReviewResult(parsed.review, { title: "T", targetLabel: "x" }), /No material findings\.\n$/);
});
