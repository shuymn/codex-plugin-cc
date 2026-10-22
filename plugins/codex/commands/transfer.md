---
description: Transfer the current Claude Code session into a resumable Codex thread
argument-hint: "[--source <claude-jsonl>] [--cwd <dir>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run the adapter exactly once, in the foreground, with this Bash command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex.ts" transfer <<'CODEX_PLUGIN_ARGS_<NONCE>'
$ARGUMENTS
CODEX_PLUGIN_ARGS_<NONCE>
```

Command rules:
- Replace both `<NONCE>` markers with the same fresh random string of at least 16 letters and digits that does not appear in the arguments.
- Keep the arguments between the two marker lines exactly as given.

Present stdout exactly as returned, including the Codex session ID and the `codex resume <session-id>` command. On failure, show the first line of stderr; if the exit code is 3, tell the user to run `/codex:setup`.
