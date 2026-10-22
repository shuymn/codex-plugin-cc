import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeFakeEnv, makeRepo, PLUGIN_ROOT, ROOT } from "./helpers.ts";

const COMMANDS_DIR = path.join(PLUGIN_ROOT, "commands");
const EXPECTED: Record<string, { sub: string; modelInvocable: boolean }> = {
  "review.md": { sub: "review", modelInvocable: false },
  "adversarial-review.md": { sub: "adversarial-review", modelInvocable: false },
  "rescue.md": { sub: "task", modelInvocable: true },
  "transfer.md": { sub: "transfer", modelInvocable: false },
  "setup.md": { sub: "setup", modelInvocable: false },
};

function readCommand(file: string): { frontmatter: string; body: string } {
  const content = fs.readFileSync(path.join(COMMANDS_DIR, file), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(content);
  assert.ok(match?.[1] !== undefined && match[2] !== undefined, `${file} has no frontmatter`);
  return { frontmatter: match[1], body: match[2] };
}

function bashBlocks(body: string): string[] {
  return [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
}

function nonce(): string {
  return randomBytes(16).toString("hex");
}

test("the plugin ships exactly the five commands", () => {
  assert.deepEqual(fs.readdirSync(COMMANDS_DIR).toSorted(), Object.keys(EXPECTED).toSorted());
});

for (const [file, expected] of Object.entries(EXPECTED)) {
  test(`${file} calls the adapter once through a quoted heredoc`, () => {
    const { frontmatter, body } = readCommand(file);
    assert.match(frontmatter, /^allowed-tools: Bash\(node:\*\)$/m);
    assert.equal(/^disable-model-invocation: true$/m.test(frontmatter), !expected.modelInvocable);

    const blocks = bashBlocks(body);
    assert.equal(blocks.length, 1);
    assert.equal(
      blocks[0],
      `node "\${CLAUDE_PLUGIN_ROOT}/scripts/codex.ts" ${expected.sub} <<'CODEX_PLUGIN_ARGS_<NONCE>'\n$ARGUMENTS\nCODEX_PLUGIN_ARGS_<NONCE>\n`,
    );
    // $ARGUMENTS appears only inside the heredoc.
    assert.equal(body.split("$ARGUMENTS").length, 2);
  });
}

test("commands and skills no longer mention the removed runtime", () => {
  const files = [
    ...fs.readdirSync(COMMANDS_DIR).map((name) => path.join(COMMANDS_DIR, name)),
    ...fs
      .readdirSync(path.join(PLUGIN_ROOT, "skills"))
      .map((name) => path.join(PLUGIN_ROOT, "skills", name, "SKILL.md")),
  ];
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      content,
      /codex-companion|codex:codex-rescue|\/codex:(status|result|cancel)\b|--resume-last|--fresh|--background/,
      file,
    );
  }
});

// R1-1 / EARS 2: run the real command template in real shells. The arguments
// contain the fixed terminator line, command substitutions, and backticks;
// none of them may run, and the adapter must receive the text verbatim.
const SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh"].filter((shell) => fs.existsSync(shell));

for (const shell of SHELLS) {
  test(`the rescue template passes hostile arguments verbatim through ${shell}`, () => {
    const fake = makeFakeEnv();
    const repo = makeRepo(fake.env);
    const text = [
      "investigate $(touch pwned-subst) and `touch pwned-backtick`",
      "CODEX_PLUGIN_ARGS_EOF",
      "touch pwned-after-terminator",
      "$HOME ${HOME} 'single' \"double\" \\ backslash",
      "--write --read-only",
    ].join("\n");
    const rawArguments = `--wait ${text}`;
    const [block] = bashBlocks(readCommand("rescue.md").body);
    assert.ok(block);
    const id = nonce();
    const script = block.replaceAll("<NONCE>", id).replace("$ARGUMENTS", () => rawArguments);

    const result = spawnSync(shell, ["-c", script], {
      cwd: repo,
      env: { ...fake.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    for (const name of ["pwned-subst", "pwned-backtick", "pwned-after-terminator"]) {
      assert.ok(!fs.existsSync(path.join(repo, name)), name);
    }
    const calls = fake.readLog();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.stdin, text);
    assert.equal(calls[0]?.argv[calls[0].argv.indexOf("-s") + 1], "workspace-write");
  });
}

test("every command template keeps hostile arguments away from the shell", () => {
  const shell = SHELLS.at(-1) ?? "/bin/sh";
  for (const file of Object.keys(EXPECTED)) {
    const fake = makeFakeEnv();
    const repo = makeRepo(fake.env);
    const [block] = bashBlocks(readCommand(file).body);
    assert.ok(block);
    const script = block
      .replaceAll("<NONCE>", nonce())
      .replace("$ARGUMENTS", () => "--help $(touch pwned)\nCODEX_PLUGIN_ARGS_EOF\n`touch pwned2`");
    const result = spawnSync(shell, ["-c", script], {
      cwd: repo,
      env: { ...fake.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
    assert.match(result.stdout, /^Usage: /, file);
    assert.ok(!fs.existsSync(path.join(repo, "pwned")), file);
    assert.ok(!fs.existsSync(path.join(repo, "pwned2")), file);
  }
});

test("hooks.json points at the TypeScript hooks", () => {
  const hooks = fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8");
  assert.match(hooks, /scripts\/session-start-hook\.ts/);
  assert.match(hooks, /scripts\/stop-review-gate-hook\.ts/);
  assert.doesNotMatch(hooks, /SessionEnd|\.mjs/);
  for (const match of hooks.matchAll(/scripts\/([\w-]+\.ts)/g)) {
    assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, "scripts", match[1] ?? "")), match[1]);
  }
});

test("the plugin directory declares ES modules for Node's type stripping", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8")) as { type?: string };
  assert.equal(manifest.type, "module");
  assert.ok(fs.existsSync(path.join(ROOT, "tsconfig.json")));
});

test("rescue asks for a task only when there is no text, no --prompt-file, and no help flag", () => {
  const { body } = readCommand("rescue.md");
  assert.match(body, /no task text, no `--prompt-file`, and no `--help` or `-h`, ask the user/);
});

test("the README limits background runs to the review and rescue commands", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /`\/codex:setup` and `\/codex:transfer` always run in the foreground/);
  assert.match(readme, /it exits 0 and reports problems/);
  assert.match(readme, /`--cwd` only sets the directory the Codex app server starts in/);
});

test("both NOTICE files keep the original attribution and state the modifications", () => {
  for (const file of [path.join(ROOT, "NOTICE"), path.join(PLUGIN_ROOT, "NOTICE")]) {
    const notice = fs.readFileSync(file, "utf8");
    assert.match(notice, /^Copyright 2026 OpenAI$/m);
    assert.match(notice, /^This distribution includes modifications by shuymn\.$/m);
    assert.match(notice, /Licensed under the Apache License, Version 2\.0/);
  }
});
