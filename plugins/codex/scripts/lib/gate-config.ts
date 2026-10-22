import fs from "node:fs";
import path from "node:path";

import { pluginDataDir, writeFileAtomic } from "./env.ts";
import { isRecord } from "./json.ts";

// review-gate.json: {"workspaces": {"<realpath of workspace root>": true}}

type GateConfig = { workspaces: Record<string, boolean> };

function configPath(): string {
  return path.join(pluginDataDir(), "review-gate.json");
}

function workspaceKey(workspaceRoot: string): string {
  try {
    return fs.realpathSync(workspaceRoot);
  } catch {
    return path.resolve(workspaceRoot);
  }
}

function readConfig(): GateConfig {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    if (isRecord(parsed) && isRecord(parsed.workspaces)) {
      const workspaces: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(parsed.workspaces)) {
        if (value === true) {
          workspaces[key] = true;
        }
      }
      return { workspaces };
    }
  } catch {
    // A missing or unreadable file means the gate is off everywhere.
  }
  return { workspaces: {} };
}

export function isReviewGateEnabled(workspaceRoot: string): boolean {
  return readConfig().workspaces[workspaceKey(workspaceRoot)] === true;
}

export function setReviewGate(workspaceRoot: string, enabled: boolean): void {
  const config = readConfig();
  const key = workspaceKey(workspaceRoot);
  if (enabled) {
    config.workspaces[key] = true;
  } else {
    delete config.workspaces[key];
  }
  writeFileAtomic(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}
