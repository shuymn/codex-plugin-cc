import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeTempDir, ROOT } from "./helpers.ts";

const SCRIPT = path.join(ROOT, "scripts", "bump-version.ts");

function writeJson(filePath: string, json: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

function readJson(filePath: string): {
  version?: string;
  metadata: { version: string };
  plugins: { version: string }[];
} {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as {
    version?: string;
    metadata: { version: string };
    plugins: { version: string }[];
  };
}

function run(args: readonly string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
}

function makeVersionFixture(): string {
  const root = makeTempDir();
  writeJson(path.join(root, "package.json"), { name: "codex-plugin-cc", version: "1.0.2" });
  writeJson(path.join(root, "plugins", "codex", ".claude-plugin", "plugin.json"), { name: "codex", version: "1.0.2" });
  writeJson(path.join(root, ".claude-plugin", "marketplace.json"), {
    metadata: { version: "1.0.2" },
    plugins: [{ name: "codex", version: "1.0.2" }],
  });
  return root;
}

test("bump-version updates every release manifest", () => {
  const root = makeVersionFixture();
  const result = run(["--root", root, "1.2.3"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson(path.join(root, "package.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, "plugins", "codex", ".claude-plugin", "plugin.json")).version, "1.2.3");
  const marketplace = readJson(path.join(root, ".claude-plugin", "marketplace.json"));
  assert.equal(marketplace.metadata.version, "1.2.3");
  assert.equal(marketplace.plugins[0]?.version, "1.2.3");
});

test("bump-version check mode reports stale metadata", () => {
  const root = makeVersionFixture();
  writeJson(path.join(root, "package.json"), { name: "codex-plugin-cc", version: "1.0.3" });
  const result = run(["--root", root, "--check"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /plugins\/codex\/\.claude-plugin\/plugin\.json version/);
  assert.match(result.stderr, /\.claude-plugin\/marketplace\.json metadata\.version/);
});

test("bump-version rejects a version that is not semver-like", () => {
  const root = makeVersionFixture();
  const result = run(["--root", root, "v2"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /semver-like/);
});
