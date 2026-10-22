---
description: Check whether the local Codex CLI is ready, and turn the stop-time review gate on or off
argument-hint: "[--enable-review-gate | --disable-review-gate] [--cwd <dir>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run the adapter exactly once, in the foreground, with this Bash command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex.ts" setup <<'CODEX_PLUGIN_ARGS_<NONCE>'
$ARGUMENTS
CODEX_PLUGIN_ARGS_<NONCE>
```

Command rules:
- Replace both `<NONCE>` markers with the same fresh random string of at least 16 letters and digits that does not appear in the arguments.
- Keep the arguments between the two marker lines exactly as given.

Present stdout to the user, including its next steps. Do not install Codex or log in on the user's behalf. If Codex is not logged in, keep the suggestion to run `!codex login`. On failure, show the first line of stderr.
