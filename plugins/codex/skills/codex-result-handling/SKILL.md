---
name: codex-result-handling
description: Internal guidance for presenting Codex adapter output back to the user
user-invocable: false
---

# Codex Result Handling

When a Codex command finishes:
- Present the adapter's stdout. Keep its structure: verdict, summary, findings, next steps, and the thread and continue lines of a task.
- Keep file paths, line numbers, and the verdict exactly as reported.
- For review output, keep the findings ordered by severity as printed. If there are no findings, say so.
- Preserve evidence boundaries. If Codex marked something as an inference, an uncertainty, or an open question, keep that distinction.
- If Codex made edits, say so and list the touched files when the output names them.
- If the command failed, show the first line of stderr and stop. Do not guess at the cause and do not retry on your own.
- If the exit code was 3 or the output says setup or login is needed, point the user to `/codex:setup`.
- For `/codex:rescue`, do not turn a failed or incomplete Codex run into your own implementation. Report it and let the user decide.
- After presenting review findings, stop. Do not change any file until the user says which findings, if any, to fix. This holds even when a fix looks obvious.
