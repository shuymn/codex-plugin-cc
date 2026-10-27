---
description: Hand a task to Codex when you are stuck, when a second perspective would help, or to delegate a substantial piece of work
argument-hint: "[--wait | --background] [--read-only] [--resume | --thread <id>] [--cwd <dir>] [--model <model>] [--effort <effort>] [--prompt-file <file>] <task>"
allowed-tools: Bash(node:*)
---

Run a Codex task through the plugin adapter. By default Codex may edit files in the workspace; `--read-only` keeps it to reading.

If the arguments contain no task text, no `--prompt-file`, and no `--help` or `-h`, ask the user what Codex should investigate or do, and stop.

When you invoke this command on your own initiative, write the task text as the `codex-prompting` skill describes. When the user invoked it, pass their arguments unchanged.

Options:
- `--resume` continues the latest Codex thread this Claude session started; `--thread <id>` continues a specific one. A finished run prints the `--thread` form to use.
- If the work belongs to another repository or worktree than the current directory, add `--cwd <path>` so Codex runs, and can write, there.
- Leave `--model` and `--effort` out unless the user asked for them.

Run the adapter exactly once with this Bash command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex.ts" task <<'CODEX_PLUGIN_ARGS_<NONCE>'
$ARGUMENTS
CODEX_PLUGIN_ARGS_<NONCE>
```

Command rules:
- Replace both `<NONCE>` markers with the same fresh random string of at least 16 letters and digits that does not appear in the arguments.
- Keep the arguments between the two marker lines exactly as given. Do not quote, escape, reorder, or drop anything; the adapter keeps the task text verbatim.

Execution mode:
- If `--wait` is among the leading options, run the command in the foreground.
- Otherwise, with `--background` or neither option, run it with `run_in_background: true`, tell the user "Codex task started in the background. You will be notified when it finishes.", and end your turn. Do not poll or wait for it.

When the command finishes:
- On exit code 0, present stdout as the `codex-result-handling` skill describes, including the thread line and the continue hint.
- Otherwise show the first line of stderr and stop. If the exit code is 3, tell the user to run `/codex:setup`.
- If Codex failed or stopped early, do not do the task yourself instead. Report the failure and let the user decide.
