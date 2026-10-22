---
name: codex-prompting
description: Internal guidance for writing the task text Claude passes to /codex:rescue
user-invocable: false
---

# Codex Prompting

Use this skill when you invoke `/codex:rescue` yourself and write the task text. Codex adds its own model-specific instructions and reads the repository's `AGENTS.md`, so this skill does not target a particular model.

Current Codex models infer intent and choose their own steps well. Over-specified prompts constrain them and can make them stop early, so state the outcome and leave the method to Codex.

Include:
- The goal in the user's terms, with the evidence the user supplied: failure output, file paths, commit refs.
- What done looks like. When the work includes running, inspecting, and fixing, say so ("reproduce the failure, fix it, and confirm the test passes") so Codex does not stop after a first pass.
- Constraints the user stated: scope limits, behavior that must not change, read-only intent (also pass `--read-only`).
- What to return, when the user cares about the shape: for example, root cause with supporting evidence for a diagnosis.

Leave out:
- Step-by-step procedures, required file reads, or repository surveys.
- Generic instructions to write or run tests. Name tests only when the user named them.
- "Ask before acting" or "stop for review" wording, unless the user asked for that checkpoint.
- Repeated or emphatic rules, XML scaffolding, and output-format boilerplate.
- Your own diagnosis or proposed fix.

Options:
- Put options before the task text. Text that starts with `-` goes after `--`.
- For a follow-up on the same Codex thread, pass `--resume` (the latest thread of this session) or `--thread <id>` (the id a finished run printed), and send only the new instruction.
- When the work belongs to another repository or worktree, pass `--cwd <path>`.
- For reviewing local git changes, use `/codex:review` or `/codex:adversarial-review` instead; they carry their own review contract.

When revising this skill for a new model, start from OpenAI's current model guide: https://developers.openai.com/api/docs/guides/latest-model
