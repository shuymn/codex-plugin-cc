import assert from "node:assert/strict";
import test from "node:test";

import {
  type ArgumentSpec,
  parseLeadingOptions,
  stripTrailingNewline,
  UsageError,
} from "../plugins/codex/scripts/lib/args.ts";

const TASK: ArgumentSpec = {
  booleans: ["wait", "read-only", "resume"],
  values: ["cwd", "model", "effort", "prompt-file", "thread"],
  text: "optional",
};

const REVIEW: ArgumentSpec = {
  booleans: ["wait"],
  values: ["cwd", "base", "model", "effort"],
  text: "forbidden",
  textForbiddenHint: "Use /codex:adversarial-review for focus text.",
};

const SETUP: ArgumentSpec = {
  booleans: ["enable-review-gate", "disable-review-gate"],
  values: ["cwd"],
  text: "forbidden",
  exclusive: [["enable-review-gate", "disable-review-gate"]],
};

function parseOk(raw: string, spec: ArgumentSpec = TASK) {
  const result = parseLeadingOptions(raw, spec);
  assert.equal(result.help, false);
  if (result.help) {
    throw new Error("unreachable");
  }
  return result;
}

function parseError(raw: string, spec: ArgumentSpec = TASK): UsageError {
  let caught: unknown;
  try {
    parseLeadingOptions(raw, spec);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof UsageError, `expected a usage error for ${JSON.stringify(raw)}, got ${String(caught)}`);
  return caught;
}

test("empty input has no options and empty text", () => {
  const result = parseOk("");
  assert.deepEqual(result.options, {});
  assert.equal(result.text, "");
});

test("leading options are parsed and the rest is text", () => {
  const result = parseOk("--wait --model gpt-5 --effort high fix the bug");
  assert.deepEqual(result.options, { wait: true, model: "gpt-5", effort: "high" });
  assert.equal(result.text, "fix the bug");
});

test("parsing stops at the first non-option token", () => {
  const result = parseOk("explain --write");
  assert.deepEqual(result.options, {});
  assert.equal(result.text, "explain --write");
});

test("text keeps option-like words, quotes, and newlines verbatim", () => {
  const text = `fix "it" now\n--write\n  --read-only --resume --model x\n'unterminated`;
  const result = parseOk(`--read-only ${text}`);
  assert.deepEqual(result.options, { "read-only": true });
  assert.equal(result.text, text);
});

test("leading whitespace is skipped but the text is not trimmed", () => {
  const result = parseOk(" \n\t--wait \n  hello  \n");
  assert.deepEqual(result.options, { wait: true });
  assert.equal(result.text, "hello  \n");
});

test("everything after -- is text", () => {
  const result = parseOk("--wait -- --read-only is text");
  assert.deepEqual(result.options, { wait: true });
  assert.equal(result.text, "--read-only is text");
});

test("a trailing -- yields empty text", () => {
  const result = parseOk("--wait --");
  assert.equal(result.text, "");
});

test("quoted values are unquoted", () => {
  assert.equal(parseOk("--cwd 'my dir' go").options.cwd, "my dir");
  assert.equal(parseOk('--cwd "a b" go').options.cwd, "a b");
  assert.equal(parseOk("--model ''").options.model, "");
});

test("-C is an alias for --cwd", () => {
  assert.deepEqual(parseOk("-C /tmp go").options, { cwd: "/tmp" });
  assert.match(parseError("-C /a --cwd /b").message, /--cwd/);
});

test("an unterminated quote in an option value is a usage error", () => {
  assert.match(parseError("--cwd 'oops go").message, /--cwd/);
});

test("an unterminated quote in the text is allowed", () => {
  assert.equal(parseOk("--wait don't stop").text, "don't stop");
});

test("unknown leading options are rejected with the option name first", () => {
  assert.match(parseError("--write fix it").message.split("\n")[0] ?? "", /--write/);
  assert.match(parseError("-x fix it").message, /-x/);
});

test("--key=value is rejected even for known options", () => {
  assert.match(parseError("--model=gpt-5 go").message, /--model=gpt-5/);
});

test("a missing value is rejected", () => {
  assert.match(parseError("--model").message, /--model/);
  assert.match(parseError("--model --wait go").message, /--model/);
});

test("a duplicated option is rejected", () => {
  assert.match(parseError("--wait --wait go").message, /--wait/);
  assert.match(parseError("--model a --model b go").message, /--model/);
});

test("--help and -h request help", () => {
  assert.equal(parseLeadingOptions("--help", TASK).help, true);
  assert.equal(parseLeadingOptions("-h", TASK).help, true);
  assert.equal(parseLeadingOptions("--wait --help anything", TASK).help, true);
});

test("--help after the text is just text", () => {
  assert.equal(parseOk("explain --help").text, "explain --help");
});

test("forbidden text is rejected with the hint", () => {
  const error = parseError("--wait please focus on auth", REVIEW);
  assert.match(error.message, /adversarial-review/);
  assert.match(parseError("-- focus", REVIEW).message, /adversarial-review/);
});

test("exclusive options are rejected together", () => {
  assert.match(parseError("--enable-review-gate --disable-review-gate", SETUP).message, /--enable-review-gate/);
  assert.deepEqual(parseOk("--enable-review-gate", SETUP).options, { "enable-review-gate": true });
});

test("-C is rejected when the command takes no --cwd", () => {
  assert.match(parseError("-C /tmp", { booleans: [], values: [], text: "optional" }).message, /-C/);
});

test("stripTrailingNewline removes exactly one trailing newline", () => {
  assert.equal(stripTrailingNewline("a\n\n"), "a\n");
  assert.equal(stripTrailingNewline("a"), "a");
  assert.equal(stripTrailingNewline(""), "");
});
