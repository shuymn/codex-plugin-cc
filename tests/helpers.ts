import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
export const ADAPTER = path.join(PLUGIN_ROOT, "scripts", "codex.ts");
const FAKE_CODEX = path.join(ROOT, "tests", "fixtures", "fake-codex.ts");

// Standard system directories; they hold no codex.
const SYSTEM_PATH = ["/usr/bin", "/bin"];

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

export function makeTempDir(prefix = "codex-plugin-test-"): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function findOnPath(command: string): string {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  const found = result.stdout.trim();
  if (result.status !== 0 || !found) {
    throw new Error(`${command} is required for the tests`);
  }
  return found;
}

// Builds an environment without Claude Code's or the real Codex's state, with
// PATH limited to node, git, (unless disabled) the fake codex, and the system
// directories that Git's own shell scripts, such as `git submodule` on Linux,
// need for basename and other coreutils.
export type FakeEnv = {
  env: NodeJS.ProcessEnv;
  home: string;
  dataDir: string;
  logPath: string;
  readLog: () => FakeCall[];
};

export type FakeCall = {
  argv: string[];
  cwd: string;
  scenario: string;
  pid: number;
  ignored?: boolean;
  completed?: string;
  launcher?: boolean;
  childPid?: number;
  stdin?: string | null;
  rejected?: string;
  signal?: string;
  rpc?: { id?: number | string; method?: string; error?: { code: number } };
  appServerClosed?: boolean;
};

export function makeFakeEnv(options: { codex?: boolean; scenario?: string } = {}): FakeEnv {
  const base = makeTempDir();
  const tools = path.join(base, "tools");
  const fakeBin = path.join(base, "fake-bin");
  const home = path.join(base, "home");
  const dataDir = path.join(base, "plugin-data");
  const logPath = path.join(base, "codex-calls.jsonl");
  fs.mkdirSync(tools);
  fs.mkdirSync(fakeBin);
  fs.mkdirSync(home);
  fs.symlinkSync(process.execPath, path.join(tools, "node"));
  fs.symlinkSync(findOnPath("git"), path.join(tools, "git"));
  fs.writeFileSync(path.join(fakeBin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`, {
    mode: 0o755,
  });

  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(CLAUDE|CODEX|FAKE_CODEX|GIT_)/.test(key) && key !== "HOME" && key !== "PATH") {
      env[key] = value;
    }
  }
  Object.assign(env, {
    HOME: home,
    PATH: [...(options.codex === false ? [] : [fakeBin]), tools, ...SYSTEM_PATH].join(path.delimiter),
    CLAUDE_PLUGIN_DATA: dataDir,
    CODEX_HOME: path.join(home, ".codex"),
    FAKE_CODEX_LOG: logPath,
    FAKE_CODEX_SCENARIO: options.scenario ?? "ok",
    GIT_CONFIG_NOSYSTEM: "1",
    // Keeps git from finding a repository above the temporary directories.
    GIT_CEILING_DIRECTORIES: fs.realpathSync(os.tmpdir()),
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  });

  return {
    env,
    home,
    dataDir,
    logPath,
    readLog: () =>
      fs.existsSync(logPath)
        ? fs
            .readFileSync(logPath, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as FakeCall)
        : [],
  };
}

export function runAdapter(
  subcommand: string,
  input: string,
  options: { env: NodeJS.ProcessEnv; cwd: string },
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [ADAPTER, subcommand], {
    cwd: options.cwd,
    env: options.env,
    input,
    encoding: "utf8",
    timeout: 60_000,
  });
}

export function spawnAdapter(subcommand: string, input: string, options: { env: NodeJS.ProcessEnv; cwd: string }) {
  const child = spawn(process.execPath, [ADAPTER, subcommand], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(input);
  return child;
}

export function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

// A repository with one commit on main.
export function makeRepo(env: NodeJS.ProcessEnv): string {
  const repo = makeTempDir("codex-plugin-repo-");
  git(repo, ["init", "-q", "-b", "main"], env);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, ["add", "README.md"], env);
  git(repo, ["commit", "-q", "-m", "initial"], env);
  return repo;
}

export function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Waits for a file the fake codex writes once it is running, and returns its content.
export async function waitForFile(file: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) || fs.readFileSync(file, "utf8") === "") {
    if (Date.now() > deadline) {
      throw new Error(`${file} never appeared`);
    }
    await sleep(20);
  }
  return fs.readFileSync(file, "utf8");
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Orphaned processes are reaped by init shortly after they exit.
export async function waitUntilGone(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) {
      return false;
    }
    await sleep(20);
  }
  return true;
}

export function exitCodeOf(child: { on: (event: "close", listener: (code: number | null) => void) => unknown }) {
  return new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });
}
