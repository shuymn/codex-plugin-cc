# Changelog

## 3.0.1

Fixes:

- Fixed write-capable runs in a repository with `core.splitIndex=true` writing a new `sharedindex.*` file into the repository's `.git` directory on every snapshot.
- Documented two change-report limits: edits to an ignored file that was added with `git add -f` but is absent from `HEAD` report `none`, and sparse checkouts are untested.

## 3.0.0

Replaced the built-in role commands, hooks, and skills with a single role-free executable, `codex-run`, in `plugins/codex/bin/` (added to the Bash tool's `PATH` by Claude Code). The caller writes the role and instructions in the prompt file.

Breaking changes:

- Removed `/codex:review`, `/codex:adversarial-review`, `/codex:rescue`, `/codex:setup`, and `/codex:transfer`.
- Removed the stop-time review gate, all hooks (`SessionStart` and `Stop`), built-in review prompts and output schemas, and the `codex-prompting` and `codex-result-handling` skills.
- Removed `scripts/codex.ts`, the heredoc argument protocol, `--resume`, `--wait`, `--background`, and short options (`-C`, `-h`). `codex-run` takes strict long options (`--prompt-file`, `--cwd`, `--read-only`, `--thread`, `--model`, `--effort`, `--help`), with `--prompt-file` required as an absolute path.
- Default sandbox is `workspace-write`; pass `--read-only` for a read-only run.
- Write-capable runs snapshot the Git working tree before and after Codex runs (requiring Git 2.45 or later) and print a change report on stdout (`none`, up to 10 changed paths with full lists written to `changes.txt`, or `unknown: <reason>`).
- Codex's final message is written unchanged to `<state>/runs/<run id>/result.md`; stdout prints a short summary report. Run directories older than 7 days are pruned automatically.
- Thread records are stored per thread id at `<state>/threads/<thread id>.json` without Claude session scoping, keeping the same-repository check across worktrees. 2.x thread records are not carried over.
- Write-capable runs create a temporary scratch directory passed to Codex as `TMPDIR` and `--add-dir`, and delete it after Codex's process group exits.
- Each run prints a run id and appends a metadata-only JSON line to `<state>/runs.jsonl`.

Fixes:

- Fixed stopping a background `codex-run` on macOS from exiting 1 with `scratch left:` and `changes: unknown: Codex processes may still be running` when no Codex process remained (a process group holding only unreaped zombies returns `EPERM`). Interrupted runs now exit 128+n, report `changes: unknown: interrupted`, and delete the scratch directory.

## 2.1.2

- The SessionStart hook replaces its earlier exports in `CLAUDE_ENV_FILE` instead of appending them again on every resume and compaction. In long sessions the repeated lines made every Bash tool call fail.

## 2.1.1

- `--resume` and `--thread` continue a thread in another worktree of the repository it started in, instead of refusing because the Git root differs.
- `/codex:rescue`, `/codex:review`, and `/codex:adversarial-review` accept `--background` again. It states the default and cannot be combined with `--wait`.

## 2.1.0

- The stop-time review gate now reviews changes in the working tree instead of Claude's previous turn. It compares Git tree snapshots of the working tree, skips Codex when nothing changed since the last allowed snapshot, and reviews commits made during the session.
- Codex answers the gate with a structured verdict (`--output-schema`), and blocks only for findings tied to a file and line. The `ALLOW:`/`BLOCK:` first-line answer is gone.
- After three blocks with findings in a row, if the fourth review also blocks, the gate lets Claude stop and shows those findings to the user. Failed reviews still block but do not count toward this limit.
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
