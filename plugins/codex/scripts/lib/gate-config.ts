import fs from "node:fs";
import path from "node:path";

import { pluginDataDir, writeFileAtomic } from "./env.ts";
import { canonicalWorkspaceRoot } from "./git.ts";
import { isRecord } from "./json.ts";

// review-gate.json: {"workspaces": {"<realpath of workspace root>": true}}

type GateConfig = { workspaces: Record<string, boolean> };

function configPath(): string {
  return path.join(pluginDataDir(), "review-gate.json");
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
  return readConfig().workspaces[canonicalWorkspaceRoot(workspaceRoot)] === true;
}

// Whether the gate is on for any workspace, for when the workspace itself
// cannot be told.
export function isReviewGateEnabledAnywhere(): boolean {
  return Object.keys(readConfig().workspaces).length > 0;
}

export function setReviewGate(workspaceRoot: string, enabled: boolean): void {
  const config = readConfig();
  const key = canonicalWorkspaceRoot(workspaceRoot);
  if (enabled) {
    config.workspaces[key] = true;
  } else {
    delete config.workspaces[key];
  }
  writeFileAtomic(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}
