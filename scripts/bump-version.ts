import fs from "node:fs";
import path from "node:path";

type Json = Record<string, unknown>;
type VersionValue = { label: string; get: (json: Json) => unknown; set: (json: Json, version: string) => void };
type Target = { file: string; values: VersionValue[] };
type Options = { check: boolean; help: boolean; root: string; version: string | null };

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, label: string): Json {
  if (!isObject(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
  return value;
}

function findMarketplacePlugin(json: Json): Json {
  const plugins = Array.isArray(json.plugins) ? json.plugins : [];
  const plugin: unknown = plugins.find((entry: unknown) => isObject(entry) && entry.name === "codex");
  return requireObject(plugin, ".claude-plugin/marketplace.json plugins[codex]");
}

const topLevelVersion: VersionValue = {
  label: "version",
  get: (json) => json.version,
  set: (json, version) => {
    json.version = version;
  },
};

const TARGETS: Target[] = [
  { file: "package.json", values: [topLevelVersion] },
  { file: "plugins/codex/.claude-plugin/plugin.json", values: [topLevelVersion] },
  {
    file: ".claude-plugin/marketplace.json",
    values: [
      {
        label: "metadata.version",
        get: (json) => (isObject(json.metadata) ? json.metadata.version : undefined),
        set: (json, version) => {
          requireObject(json.metadata, ".claude-plugin/marketplace.json metadata").version = version;
        },
      },
      {
        label: "plugins[codex].version",
        get: (json) => findMarketplacePlugin(json).version,
        set: (json, version) => {
          findMarketplacePlugin(json).version = version;
        },
      },
    ],
  },
];

function usage(): string {
  return [
    "Usage:",
    "  node scripts/bump-version.ts <version>",
    "  node scripts/bump-version.ts --check [version]",
    "",
    "Options:",
    "  --check       Verify manifest versions. Uses package.json when version is omitted.",
    "  --root <dir>  Run against a different repository root.",
    "  --help        Print this help.",
  ].join("\n");
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { check: false, help: false, root: process.cwd(), version: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--root") {
      const root = argv[index + 1];
      if (!root) {
        throw new Error("--root requires a directory.");
      }
      options.root = root;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (options.version) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    } else {
      options.version = arg;
    }
  }

  options.root = path.resolve(options.root);
  return options;
}

function validateVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Expected a semver-like version such as 1.0.3, got: ${version}`);
  }
}

function readJson(root: string, file: string): Json {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  return requireObject(parsed, file);
}

function writeJson(root: string, file: string, json: Json): void {
  fs.writeFileSync(path.join(root, file), `${JSON.stringify(json, null, 2)}\n`);
}

function readPackageVersion(root: string): string {
  const version = readJson(root, "package.json").version;
  if (typeof version !== "string") {
    throw new Error("package.json version must be a string.");
  }
  validateVersion(version);
  return version;
}

function checkVersions(root: string, expectedVersion: string): string[] {
  const mismatches: string[] = [];
  for (const target of TARGETS) {
    const json = readJson(root, target.file);
    for (const value of target.values) {
      const actual = value.get(json);
      if (actual !== expectedVersion) {
        const found = typeof actual === "string" ? actual : "<missing>";
        mismatches.push(`${target.file} ${value.label}: expected ${expectedVersion}, found ${found}`);
      }
    }
  }
  return mismatches;
}

function bumpVersion(root: string, version: string): string[] {
  const changedFiles: string[] = [];
  for (const target of TARGETS) {
    const json = readJson(root, target.file);
    const before = JSON.stringify(json);
    for (const value of target.values) {
      value.set(json, version);
    }
    if (JSON.stringify(json) !== before) {
      writeJson(root, target.file, json);
      changedFiles.push(target.file);
    }
  }
  return changedFiles;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const version = options.version ?? (options.check ? readPackageVersion(options.root) : null);
  if (!version) {
    throw new Error(`Missing version.\n\n${usage()}`);
  }
  validateVersion(version);

  if (options.check) {
    const mismatches = checkVersions(options.root, version);
    if (mismatches.length > 0) {
      throw new Error(`Version metadata is out of sync:\n${mismatches.join("\n")}`);
    }
    console.log(`All version metadata matches ${version}.`);
    return;
  }

  const changedFiles = bumpVersion(options.root, version);
  const touched = changedFiles.length > 0 ? changedFiles.join(", ") : "no files changed";
  console.log(`Set version metadata to ${version}: ${touched}.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
