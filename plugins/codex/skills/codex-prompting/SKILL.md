---
name: codex-prompting
description: Internal guidance for shaping a rescue request into a Codex task prompt inside the Codex Claude Code plugin
user-invocable: false
---

# Codex Prompting

Use this skill when `codex:codex-rescue` shapes the user's request into the prompt text for a `task` run. Codex adds its own model-specific instructions and reads the repository's `AGENTS.md`, so this skill does not target a particular model.

Current Codex models infer intent and choose their own steps well. Over-specified prompts constrain them and can make them stop early, so state the outcome and leave the method to Codex.

Include:
- The goal in the user's terms, with the evidence the user supplied: failure output, file paths, commit refs.
- What done looks like. When the work includes running, inspecting, and fixing, say so ("reproduce the failure, fix it, and confirm the test passes") so Codex does not stop after a first pass.
- Constraints the user stated: scope limits, behavior that must not change, read-only intent.
- What to return, when the user cares about the shape: for example, root cause with supporting evidence for a diagnosis.

Leave out:
- Step-by-step procedures, required file reads, or repository surveys.
- Generic instructions to write or run tests. Name tests only when the user named them.
- "Ask before acting" or "stop for review" wording, unless the user asked for that checkpoint.
- Repeated or emphatic rules, XML scaffolding, and output-format boilerplate.
- Your own diagnosis or proposed fix.

Use `task` when the task is diagnosis, planning, research, or implementation. Use the `review` or `adversarial-review` commands for reviewing local git changes; they carry their own review contract. For a follow-up on the same thread (`task --resume-last`), send only the new instruction.

When revising this skill for a new model, start from OpenAI's current model guide: https://developers.openai.com/api/docs/guides/latest-model
