# Changelog

## 2.1.0

- The stop-time review gate now reviews changes in the working tree instead of Claude's previous turn. It compares Git tree snapshots of the working tree, skips Codex when nothing changed since the last allowed snapshot, and reviews commits made during the session.
- Codex answers the gate with a structured verdict (`--output-schema`), and blocks only for findings tied to a file and line. The `ALLOW:`/`BLOCK:` first-line answer is gone.
- After three blocks with findings in a row, the gate lets Claude stop and shows the findings to the user. Failed reviews still block but do not count toward this limit.
- The gate blocks when the working tree changes while Codex reviews it.
- A missing Codex is reported as a message to the user instead of on stderr.

## 2.0.0

The plugin is now a thin TypeScript adapter over `codex exec` with no runtime dependencies. Claude Code's background execution replaces the plugin's own job management.

Breaking changes:

- Removed `/codex:status`, `/codex:result`, and `/codex:cancel`. Background runs use Claude Code's `run_in_background`, which notifies you when a run finishes.
- Removed the `codex:codex-rescue` subagent and the `codex-cli-runtime` skill. `/codex:rescue` runs the task itself and Claude can invoke it directly.
- Removed `--background` (background is now the default; `--wait` runs in the foreground), `--fresh`, `--write`, and `--scope`.
- `/codex:rescue` lets Codex write by default; pass `--read-only` to prevent edits. `--resume` continues the latest thread of the current Claude session, and the new `--thread <id>` continues a specific one.
- Unknown leading options are now errors instead of task text, and `--key=value` is not accepted.
- Commands pass their arguments to the adapter on stdin through a quoted heredoc, so the shell never expands them.
- Reviews and tasks run through `codex exec` instead of the Codex app server and its broker; `/codex:transfer` still uses the app server for session import.
- `/codex:review` and `/codex:adversarial-review` require a Git repository and no longer ask whether to run in the background.
- `/codex:setup` no longer offers to install Codex.
- The stop-time review gate blocks when the Codex review fails, returns nothing, answers in an unexpected format, or times out after 13 minutes. Its state is stored per workspace in the plugin data directory, so earlier settings are not carried over.
- Requires Node.js 24 or later (TypeScript type stripping).
- The plugin is published from shuymn/codex-plugin-cc; the marketplace is now `shuymn-codex`.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
