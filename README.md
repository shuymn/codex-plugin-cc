# Codex plugin for Claude Code

Use Codex from inside Claude Code to review code or to hand tasks to Codex.

The plugin is a thin adapter over your local Codex CLI. Each command runs `codex exec` once with an explicit sandbox, and Claude Code's own background execution handles long runs and tells you when they finish.

## What You Get

- `/codex:review` for Codex's built-in read-only review
- `/codex:adversarial-review` for a steerable read-only review that challenges the change and its design
- `/codex:rescue` to hand a task to Codex, and to continue a Codex thread from the same Claude session
- `/codex:transfer` to continue the current Claude session in Codex
- `/codex:setup` to check the Codex CLI and to turn the optional stop-time review gate on or off

## Requirements

- **The Codex CLI**, installed and logged in. Install it with `npm install -g @openai/codex`, then run `codex login`. Codex usage counts toward your ChatGPT plan or API key limits.
- **Node.js 24 or later.** The plugin is written in TypeScript and runs through Node's built-in type stripping. It has no runtime dependencies.

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add shuymn/codex-plugin-cc
```

Install the plugin:

```bash
/plugin install codex@shuymn-codex
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/codex:setup
```

`/codex:setup` reports the Codex version, whether Codex is logged in, and the review gate state. It does not install Codex or log in for you. If Codex is not logged in, run:

```bash
!codex login
```

## Usage

Every command reads its options first and treats the rest as text. Put options before the text, and put text that starts with `-` after `--`. An unknown leading option is an error, not text. `--help` shows a command's options.

Commands run in the background by default, and Claude tells you when they finish. Add `--wait` to run in the foreground instead.

### `/codex:review`

Runs Codex's built-in review (`codex exec review`) in a read-only sandbox. It reviews the uncommitted changes, including untracked files. When there are none, it reviews the current branch against the default branch. Use `--base <ref>` to pick the base yourself.

```bash
/codex:review
/codex:review --wait
/codex:review --base main --effort high
```

It takes no focus text. Use `/codex:adversarial-review` for that.

### `/codex:adversarial-review`

Runs a read-only review that looks for the strongest reasons the change should not ship: design choices, hidden assumptions, failure modes, and tradeoffs, not only defects. It picks the same target as `/codex:review`, and any text after the options is the focus.

```bash
/codex:adversarial-review
/codex:adversarial-review --base main challenge the caching and retry design
/codex:adversarial-review --wait look for race conditions
```

The plugin checks the output against its review schema and lists the findings by severity.

### `/codex:rescue`

Hands a task to Codex. Codex may edit files in the workspace (`workspace-write` sandbox) unless you pass `--read-only`. The task text reaches Codex exactly as written, including newlines, quotes, and words like `--write`.

```bash
/codex:rescue investigate why the tests started failing
/codex:rescue --read-only explain how the session store handles concurrent writes
/codex:rescue --cwd ../other-worktree fix the failing lint check
/codex:rescue --effort high investigate the flaky integration test
```

Claude can also call it on its own when it is stuck or wants a second opinion, and you can ask Claude to delegate something to Codex.

When a task finishes, the plugin prints the Codex thread ID and how to continue:

```text
---
Codex thread: <id>  (sandbox: workspace-write, cwd: /path/to/repo, workspace: /path/to/repo)
Continue: /codex:rescue --thread <id> <follow-up>   |  Terminal: codex resume <id>
```

- `--resume` continues the latest Codex thread this Claude session started.
- `--thread <id>` continues a specific thread this Claude session started. Use it when several tasks ran in parallel.
- Either way, the thread must belong to the same workspace (Git root) as the current run.
- `--prompt-file <file>` reads the task text from a file instead.
- `--model` and `--effort` go to Codex unchanged, and Codex checks the values.

### `/codex:transfer`

Imports the current Claude Code session into a Codex thread and prints a `codex resume <session-id>` command, so you can continue the same conversation in Codex.

```bash
/codex:transfer
/codex:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's `SessionStart` hook supplies the current transcript path, and `--source` overrides it. The source must be a `.jsonl` file under `~/.claude/projects`. Older Codex versions without session import must be updated first.

### `/codex:setup`

Checks whether Codex is installed and logged in, and turns the review gate on or off for the current workspace.

```bash
/codex:setup
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

When the review gate is on, a `Stop` hook asks Codex for a read-only review of Claude's previous turn before Claude stops. If Codex answers `BLOCK`, or the review fails or times out, the hook blocks the stop so Claude can address it.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to watch the session.

## Codex Configuration

The plugin uses the `codex` binary on your `PATH` and the same configuration as running Codex directly: `~/.codex/config.toml` and trusted project-level `.codex/config.toml` files. For example, to use high reasoning effort by default:

```toml
model_reasoning_effort = "high"
```

The plugin always sets the sandbox and runs Codex with `approval_policy = "never"`, so a run never waits for an approval prompt.

## Moving Work Over To Codex

Tasks, reviews, and transfers run as regular Codex threads. Tasks and transfers print the thread ID to pass to `codex resume <id>`. For a review, pick its thread from the list that `codex resume` shows.

## Development

The tools are pinned in `mise.toml`. After cloning, run `mise install`, then `pnpm install` and `pnpm exec lefthook install` to set up the dependencies and git hooks.

```bash
pnpm run lint
pnpm run fmt
pnpm run typecheck
pnpm test
pnpm run test:cli-contract   # checks the plugin's argv against the pinned Codex CLI, without network access
```

## License

Apache-2.0. This project started as a fork of OpenAI's Codex plugin for Claude Code. See `LICENSE` and `NOTICE`.
