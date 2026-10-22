---
description: Run a read-only Codex review of the uncommitted changes or of the current branch
argument-hint: "[--wait] [--base <ref>] [--cwd <dir>] [--model <model>] [--effort <effort>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run Codex's built-in review through the plugin adapter.

This command is review-only. Do not fix issues, apply patches, or say that you are about to change files.

Run the adapter exactly once with this Bash command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex.ts" review <<'CODEX_PLUGIN_ARGS_<NONCE>'
$ARGUMENTS
CODEX_PLUGIN_ARGS_<NONCE>
```

Command rules:
- Replace both `<NONCE>` markers with the same fresh random string of at least 16 letters and digits that does not appear in the arguments.
- Keep the arguments between the two marker lines exactly as given. Do not quote, escape, reorder, or drop anything; the adapter parses them.

Execution mode:
- If `--wait` is among the leading options, run the command in the foreground.
- Otherwise run it with `run_in_background: true`, tell the user "Codex review started in the background. You will be notified when it finishes.", and end your turn. Do not poll or wait for it.

When the command finishes:
- On exit code 0, present stdout as the `codex-result-handling` skill describes.
- Otherwise show the first line of stderr and stop. If the exit code is 3, tell the user to run `/codex:setup`. Do not retry, and do not review the code yourself instead.
