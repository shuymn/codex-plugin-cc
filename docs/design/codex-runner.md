# Codex runner: a role-free entry point for running Codex from Claude Code

Status: proposed. Target: plugin 3.0.0 (breaking; no compatibility path for the 2.x commands and flags).

## Goal

Turn the plugin into one executable, `codex-run`, that an orchestrating Claude session calls from Bash to run one Codex turn: read a prompt file, run Codex in a given directory with a given sandbox, continue a thread, write Codex's final message to a file, and print a short report that includes which files the run changed in the working tree.

The plugin provides the mechanism. What Codex is asked to be (reviewer, investigator, implementer), how the request is written, and what the caller does with the answer belong to the caller.

## Design principle: detect and report

The caller is an agent that reads every report. The runner's job is to make problems noticeable to it, not to handle every case:

- Report rather than repair. When something goes wrong (a stray edit, a leftover scratch directory, an interrupted run), the runner says so in its output and leaves the decision to the caller.
- Best effort. Cleanup and detection are attempted once; a failure is reported, not retried or worked around.
- `unknown` is an acceptable answer. When the runner cannot tell, it says `unknown` with the reason instead of adding machinery to find out.
- No mechanism exists only for a rare case the caller would notice anyway.

## Non-goals

- Roles: no review, adversarial-review, or rescue commands, no review prompt or output schema, no skills that shape prompts or results.
- The stop-time review gate, session transfer, and the setup command.
- Background execution and job management inside the plugin. The caller runs `codex-run` with the Bash tool's background mode, as it already does.
- Preventing or undoing edits in the default sandbox. The plugin makes edits observable and names the baseline; what to do about them is the caller's decision (see the open decision below).
- Guarding against two runs continuing the same thread at the same time. Rounds of one thread run in sequence; the caller keeps them that way.
- Compatibility with 2.x commands, flags, thread records, or the versioned script path.

## Why: upstream intent versus actual use

The upstream plugin assumed a person typing slash commands: `/codex:rescue` hands a stuck task to Codex and lets it write by default, `/codex:review` runs Codex's built-in diff review, a `Stop` hook gates the end of a Claude turn on a Codex review, and `/codex:transfer` moves a session into Codex.

Recorded use of this fork looks different:

- About 95% of runs call the script by its versioned path in the plugin cache from Bash, bypassing the commands and the result-handling skill. A plugin update changes that path, so every caller breaks on update.
- The review commands make up about 2% of runs, transfer was used once, and the review gate is off everywhere. Setup is used mostly to toggle the gate.
- Of task runs, 84% pass a prompt file, 77% pass a working directory (usually a worktree), 95% run in the background, and a large share redirect stdout to a file. Threads continue for about 4 rounds on average, up to several dozen.
- About 90% of runs pass `--read-only`. About 1% ask for an implementation. Of the runs without `--read-only`, more than half still say "do not modify" in the prompt: the role lives in the prompt, not in the command.
- The caller carries workarounds for the plugin: prompts in files, `--thread` bookkeeping, telling Codex to delete its temporary files with `find <dir> -delete` in a dedicated directory because Codex stalls on `rm -f`, and neutral wording in requests.
- The plugin's `codex-prompting` skill says to leave out output-format instructions and to use `/codex:review` for reviews, while the caller's method prescribes severity-ordered output, lists of claims to falsify, and reviews of plans and documents that the built-in review cannot do.

The plugin's roles are unused, and the part that is used, running one Codex turn, is reached through an unstable path.

## Decisions

| #   | Decision                                                                                                                                                     | Reason                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | The plugin has no roles: no role commands, prompts, schemas, or skills.                                                                                      | Roles are written by the caller; the built-in ones contradict the caller's method and see about 2% of use.                                         |
| D2  | Default sandbox `workspace-write`; `--read-only` stays as an option.                                                                                         | Reviewers run probe scripts and mutation tests. A read-only default is reconsidered only if the change report shows unintended edits are frequent. |
| D3  | Every write-capable run reports which working-tree files changed and the baseline tree id, and nothing more.                                                 | Makes D2 observable and measurable. Recovery needs to know which current content the caller means to discard, which only the caller knows.         |
| D4  | Entry point is an executable in the plugin's `bin/` directory, `codex-run`.                                                                                  | Stable name on the Bash tool's `PATH` across plugin versions; one permission rule.                                                                 |
| D5  | Options come from argv; the prompt comes only from `--prompt-file`, an absolute path.                                                                        | No slash command remains, so the heredoc argument protocol has nothing to protect; an absolute path cannot be read against the wrong directory.    |
| D6  | The final message goes to `result.md` in a private per-run directory; stdout is a few lines.                                                                 | Callers already redirect output to files to keep it out of their context; a private file gives each run sole ownership of its result.              |
| D7  | The thread store is keyed by thread id, not by Claude session, and keeps the same-repository check.                                                          | Orchestrators continue threads across sessions and worktrees; the repository check is the part that prevents mistakes.                             |
| D8  | For write-capable runs, the runner owns a scratch directory for Codex, makes it writable, passes `TMPDIR` in Codex's environment, and deletes it afterwards. | Removes the caller's `find -delete` workaround; a directory left behind is reported, so the caller notices.                                        |
| D9  | No hooks.                                                                                                                                                    | The gate is removed, and the thread store no longer needs the Claude session id that the `SessionStart` hook exported.                             |
| D10 | Mutation tests run in the caller's working tree, with the change report; isolation is deferred.                                                              | See the open decision.                                                                                                                             |
| D11 | Each run prints a run id and appends one metadata line (no prompt or result text) to a local run log.                                                        | Measures D2: the caller joins its own notes on intent to the log by run id.                                                                        |
| D12 | No compatibility or migration for 2.x.                                                                                                                       | The plugin has one user.                                                                                                                           |

## Purpose layer

Acceptance criteria from the request. Each has its source, the scenario, the observable result and failure, and how to check it with the real Claude Code and Codex CLI.

- **P1.** When the caller runs `codex-run --prompt-file <absolute file> --cwd <dir>` from the Bash tool, the system shall run one Codex turn in `<dir>` with the file's text as the prompt, and the same command line shall keep working after a plugin update.
  - Source: usage (direct calls by versioned path, broken by updates).
  - Observable: the run completes; failure is `command not found`, another executable named `codex-run`, or a path that no longer exists.
  - Check: in a new Claude Code session, run `command -v codex-run` in the Bash tool and confirm it resolves into the plugin (not an earlier `PATH` entry), then run the command, in the foreground and in the background. Bump the plugin version, update, and repeat in the running session and in a new session; record whether a new session is needed.
- **P2.** When a run finishes, the system shall print at most 8 lines plus a change listing of at most 11 lines on stdout, naming the run id, the thread id, the exit status, the result file, and the change report, and shall write Codex's final message to the result file unchanged.
  - Source: usage (stdout redirected to files; result handling bypassed); D6.
  - Observable: the background task notification shows the short report; the result file holds the final message. Failure: the message is printed to stdout, reformatted, or missing.
  - Check: run in the background from Claude Code with a prompt that requests a specific output format; compare the result file with the final assistant message recorded for that turn in Codex's session log.
- **P3.** When the caller passes `--thread <id>` for a thread that `codex-run` started in the same repository, the system shall continue that thread, in any worktree of the repository, with the new `--cwd` and sandbox; if the thread belongs to another repository or is unknown, the system shall refuse with exit code 2 and say why.
  - Source: usage (multi-round threads in worktrees).
  - Observable: round 2 sees round 1's context and works in the new worktree; a mismatched repository is refused before Codex starts.
  - Check: round 1 in worktree A asks Codex to remember a random token. Round 2 in worktree B asks for the token and for the content of a sentinel file that exists only in B, and asks Codex to create a fixture file in B; the fixture appears in B only. A third round in B with `--read-only` asks for the same write and is refused by the sandbox. Then pass the id from a different repository.
- **P4.** Where no sandbox option is given, the system shall run Codex with `workspace-write`; where `--read-only` is given, it shall run Codex read-only.
  - Source: owner decision D2.
  - Observable: a prompt that asks Codex to create a file succeeds by default and fails under `--read-only`.
  - Check: both runs on the real CLI in a scratch repository, for a new thread and for a resumed one (P3).
- **P5.** When a write-capable run changes, adds, or deletes non-ignored files in the working tree of `--cwd`, the system shall list each such path with its status; when the snapshots are equal, it shall say `none`; when it cannot tell, it shall say `unknown` with the reason. Where more than ten files changed, the full list shall be in `changes.txt`.
  - Source: owner decision D2 ("make such edits observable").
  - Observable: the change lines on stdout, and `changes.txt` above ten changes. Failure: an edit that is not listed, or a listed file that did not change.
  - Check: three real runs: one that edits a tracked file and adds an untracked one, one that breaks a file, runs a test, and restores it (expected `none`), one that changes nothing.
- **P6.** When a write-capable run ends, the system shall delete the scratch directory it gave Codex, or report that it could not, and shall print that directory's path, so the caller's prompt need not tell Codex how to delete temporary files and the caller can tell whether a probe used it.
  - Source: caller workaround (`find -delete`).
  - Observable: the scratch directory is gone, or stdout names it as left behind; the directory the probe reports equals the printed `scratch:` path; Codex did not stall on deletion.
  - Check: a prompt that prints `$TMPDIR` in the shell tool, writes a probe script there, runs it, and does not clean up, on a new thread and on a resumed one; then confirm the printed path was the run's scratch directory and it is gone.
- **P7.** The system shall not add text to the prompt, constrain the output shape, or reformat the result.
  - Source: owner decision D1.
  - Observable: the prompt Codex received equals the file; the result file equals the final message.
  - Check: in Codex's session log for the thread, compare the turn's user message with the prompt file and its final assistant message with the result file.
- **P8.** While runs execute concurrently in different worktrees, each run's change report and result shall cover only its own worktree and its own output.
  - Source: usage (background runs in parallel worktrees).
  - Observable: two concurrent runs, one editing and one not, report `<files>` and `none`.
  - Check: start two background runs from Claude Code in two worktrees of one repository.
- **P9.** If `codex` is not on `PATH`, the system shall exit with 3; if Codex fails or ends without a final message, it shall exit with 1 and print a one-line reason on stderr.
  - Source: existing contract, kept for the caller's branching.
  - Check: run with `PATH` lacking `codex`; run with an invalid `CODEX_HOME` config.
- **P10.** When the caller stops a background run, the system shall stop the whole Codex process group and exit with 128+n, and print the thread id if Codex had reported one; if the group cannot be confirmed gone, it shall exit 1 instead and, when a scratch directory exists, name it.
  - Source: usage (95% background).
  - Check: start a long run in the background, stop the task from Claude Code, confirm no `codex` process remains and the output has the run and thread lines.

## The new surface

### Entry point

`plugins/codex/bin/codex-run`, a short POSIX shell wrapper that resolves its own real path and replaces itself with `exec node <plugin root>/scripts/codex-run.ts "$@"`, so signals reach the runner directly. Node strips types only for files with a `.ts` extension, so the wrapper cannot be the TypeScript file itself.

Options compared:

| Option                                                                         | Stable path      | Works in background Bash | Install step                  | Notes                                                                                                        |
| ------------------------------------------------------------------------------ | ---------------- | ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Plugin `bin/` on the Bash tool's `PATH` (chosen)                               | yes              | expected                 | none                          | Documented in Claude Code's plugin components reference and present in 2.1.328; details unverified (below).  |
| `SessionStart` hook writes `export PATH=<root>/bin:$PATH` to `CLAUDE_ENV_FILE` | yes, per session | yes                      | none                          | Proven mechanism (2.x exports variables this way); the fallback if `bin/` fails a check. Brings a hook back. |
| Shim on the user's `PATH` (symlink in a home `bin`)                            | yes              | yes                      | manual, repeated on reinstall | Works outside Claude Code, but goes stale after update or uninstall; the plugin cannot keep it in sync.      |
| Versioned cache path (status quo)                                              | no               | yes                      | none                          | Breaks on every update; needs a new permission rule per version.                                             |
| Slash command or skill wrapper                                                 | yes              | yes                      | none                          | The route callers bypass today; needs the heredoc argument protocol and gives the model a role prompt.       |

Unverified for `bin/`, each checked by P1 before release:

- whether the `PATH` entry follows a plugin update within a running session, or a new session is needed;
- whether `bin/` files run in place or from a copy elsewhere (Claude Code mentions an asset cache), which decides how the wrapper finds `scripts/`;
- whether background Bash tasks see the same `PATH`;
- which `codex-run` wins when another one is on `PATH`: plugin directories come after the user's entries, so an existing executable of that name shadows the plugin;
- whether `CLAUDE_PLUGIN_ROOT` or `CLAUDE_PLUGIN_DATA` are set for these executables (the design does not depend on them).

If `bin/` fails any of the first three, use the `SessionStart` fallback.

A permission rule `Bash(codex-run:*)` then covers every version.

### Options

```
codex-run --prompt-file <absolute file> [--cwd <dir>] [--read-only] [--thread <id>]
          [--model <model>] [--effort <effort>]
codex-run --help
```

- `--prompt-file <file>`: required, and must be an absolute path; a relative path is a usage error. 2.x resolved it against `--cwd` and a plain resolution against the shell's directory would pick a different file of the same name, so the runner takes neither. Missing, unreadable, or blank files are usage errors.
- `--cwd <dir>`: Codex's working root. Default: the current directory. A missing path or a non-directory is a usage error, as in 2.x.
- `--read-only`: `-s read-only`. Default: `-s workspace-write`.
- `--thread <id>`: continue a thread (see the thread store). `--resume` (latest thread of the session) is removed; it was used once and is ambiguous with parallel runs.
- `--model`, `--effort`: passed through unchanged as today (`-m`, `-c model_reasoning_effort=...`). Without them, Codex's own configuration decides.

Parsing uses `node:util` `parseArgs` in strict mode, and every parse error exits 2. A repeated option keeps its last value. Positional arguments are usage errors. Only long options exist: the 2.x short forms `-C` and `-h` are dropped, as are `--wait` and `--background`.

Codex argv. Options of `codex exec` go before the `resume` subcommand; Codex 0.169.0 rejects `-s` and `--add-dir` after it:

```
codex exec -s <mode> [--add-dir <scratch>] -c approval_policy="never" -c approvals_reviewer="user"
           --skip-git-repo-check [resume] [-m <model>] [-c model_reasoning_effort=...]
           --json -o <run dir>/result.md [<thread id>] -
```

`--add-dir` appears only on write-capable runs (D8). The approval overrides, `--skip-git-repo-check`, `--json`, and `-o` are carried over from 2.x.

### Run lifecycle

Usage errors and a refused `--thread` exit 2, and a `codex` missing from `PATH` exits 3, before anything below happens: no run directory, scratch directory, snapshot, or `run:` line. The `codex` check is a lookup on `PATH`, so `run:` stays the first line of every run that gets that far.

1. Prune run directories older than 7 days (by modification time; errors are ignored), create this run's directory, and print `run: <id>`.
2. Write-capable runs: take the baseline snapshot, then create the scratch directory and print `scratch: <path>`.
3. Start Codex with the sanitized environment (the runner's environment without the repository-selection Git variables listed under change detection) plus `TMPDIR` on write-capable runs. When Codex reports the thread start, record the thread and print `thread: <id>`.
4. Wait until Codex's process group is gone. On SIGINT or SIGTERM, `process-group.ts` stops the group in stages (SIGINT, SIGTERM, SIGKILL), as in 2.x.
5. Write-capable runs that ended normally: take the final snapshot and write the change report. After an interruption, or when the group could not be confirmed gone (`reapError`), the report is `unknown: <reason>` with the baseline id.
6. Delete the scratch directory (best effort; skipped after a `reapError`, since Codex may still be using it), append the run log line, print the remaining stdout lines, and exit.

A signal that arrives before Codex starts, or a hard kill of the runner, skips the cleanup; a scratch directory or Codex process may remain. The caller treats output without a `status:` line, or a write-capable run without a `changes:` line, as incomplete.

### Output contract

stdout, in this order:

```
run: <id>
scratch: <path>
thread: <id>
status: ok | failed | interrupted (exit <n>)
result: <run dir>/result.md
sandbox: <mode>  cwd: <path>
changes: none
```

- `scratch:` appears only on write-capable runs, before Codex starts. It is the directory the runner gave Codex; compare it with the directory a probe reports using.
- `thread:` is printed only if Codex reported a thread start, as soon as it does, so a stopped run still names its thread. A run stopped very early may name a thread Codex has not yet persisted.
- `result:` appears only on exit 0, which requires a non-empty result file.
- `changes:` is one of:
  - `none`;
  - `<n> files (baseline <tree>, paths relative to <workspace root>)`, followed by up to 10 lines `  <status> <path>` (`A`, `M`, `D`, `T`) and, beyond 10, `  ... full list: <run dir>/changes.txt`. Control characters and backslashes in paths are escaped (as `\n`, `\t`, `\\`, `\xNN`), here, in `changes.txt`, and in every other line that prints a path (`cwd:`, `scratch:`, `scratch left:`, `result:`), so each path stays on one line and reads back unambiguously;
  - `unknown: <reason>` (with `baseline <tree>` when a baseline exists);
  - `not checked: read-only`.
- `scratch left: <path>` is added when a scratch directory exists and was not deleted: deletion failed, or the run ended with a `reapError`. After a `reapError`, the caller confirms Codex's processes are gone before deleting it.

stderr: `codex-run: <one-line summary>` on failure, followed by the cleaned tail of Codex's stderr (as 2.x does).

The run directory, `<state>/runs/<run id>/`, holds:

- `result.md`: Codex's `-o` file. Each run has its own, so concurrent runs cannot overwrite each other's results. The runner never writes it. If Codex exits 0 but the file is missing or empty, the run exits 1: Codex writes `-o` only for a completed turn, while the last agent message in the event stream can be a progress message from a turn that never completed.
- `changes.txt`: written only when more than 10 files changed: the baseline and final tree ids, then one `<status>\t<path>` line per changed path.

`<state>` is `$XDG_STATE_HOME/codex-plugin-cc`, or `~/.local/state/codex-plugin-cc` when `XDG_STATE_HOME` is unset, empty, or relative.

### Exit codes

| Code  | Meaning                                                                                                                                                                          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Codex finished the turn with a final message.                                                                                                                                    |
| 1     | Codex failed, ended without a final message, the thread record could not be written, or Codex's process group could not be confirmed gone (this takes precedence over a signal). |
| 2     | Usage error, including a relative `--prompt-file`, a bad `--cwd`, and a refused `--thread`. Codex was not started.                                                               |
| 3     | `codex` not found on `PATH`.                                                                                                                                                     |
| 128+n | Stopped by signal n.                                                                                                                                                             |

The change report never changes the exit code. It is an observation for the caller, not a gate.

### Thread store

`<state>/threads/<thread id>.json` holds `{cwd, repo, updatedAt}`, where `repo` is the real path of the Git common directory (null outside Git) and `cwd` the canonical workspace root. It is written when Codex reports the thread start; a write failure stops Codex (exit 1), as in 2.x.

`--thread <id>` is accepted when the record exists and:

- the record has a `repo` and the current workspace has the same Git common directory, which allows any worktree of the repository; or
- neither the record nor the current workspace is in Git, and the canonical paths are equal.

A Git record never matches by path alone. Otherwise exit 2 with the recorded location and `codex resume <id>` as the alternative. Thread ids are validated against the existing pattern before use as file names.

The Claude session no longer scopes threads (D7). 2.x records live elsewhere and are not migrated.

### Scratch directory

On write-capable runs, after the baseline snapshot, the runner creates a scratch directory with `mkdtemp` under the system temporary directory, passes it to Codex with `--add-dir` so it is writable under `workspace-write`, and sets `TMPDIR` to it in the environment it passes to Codex's spawn. That environment is the same sanitized one the runner's Git calls use, so Codex works on the same checkout the change report measures. The runner never changes its own `process.env`, so its own temporary files (the snapshot's index) stay outside the scratch directory. After Codex's process group is gone, the runner deletes the directory, and prints `scratch left: <path>` if that fails.

Read-only runs create no scratch directory and pass no `--add-dir`.

Limits: Codex's `shell_environment_policy` decides the environment of its shell tool and can drop `TMPDIR` or replace it with another value such as `/tmp`; the runner does not try to force it. Whether `--add-dir` takes effect on `exec resume` is unverified (the argv parses on Codex 0.169.0). P6 checks both. When either does not hold, the probe writes somewhere else, which the runner does not clean; the caller notices because the directory the probe reports differs from the printed `scratch:` path, or a write is denied.

### Working-tree change detection

The runner reuses `takeSnapshot` from `snapshot.ts`: before Codex starts and after its process group is gone, it snapshots the workspace root of `--cwd` as a Git tree (tracked, untracked non-ignored, and deleted files) in a temporary index, without touching the user's index, refs, or files, and without running hooks, fsmonitor, or filter drivers. All of the runner's own Git calls (workspace root, common directory, snapshots, diff) run with the repository-selection variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`) removed from their environment, so Git resolves the repository from `--cwd`. Neither `git.ts` nor `snapshot.ts` removes them today (both pass `process.env` through), so `git()` in `git.ts` gains this: it builds the environment from `process.env` with those variables removed and then applies the caller's overrides. Callers pass only the variables they set on purpose (the snapshot's own `GIT_INDEX_FILE`, its safe configuration), never a spread of `process.env`, which would bring the removed variables back; the `{ ...process.env, ... }` spreads in `revParse()` and `safeGit()` go. Variables that only limit discovery, such as `GIT_CEILING_DIRECTORIES` (which the test harness sets), are kept. The report comes from `git diff-tree -r -z --no-renames --name-status <baseline> <final>` under the same safe configuration, parsed as NUL-separated records. Paths are relative to the workspace root, not to `--cwd`.

`none` means the two snapshots are equal as Git stores them. Git normalizes content on `git add` (for example line endings under `core.autocrlf`), so a byte change that normalization hides reports `none`.

Any error from either snapshot or from `diff-tree` becomes `unknown: <reason>` and leaves the turn's exit code as it is. Under `--read-only` both snapshots are skipped.

The snapshot needs Git 2.45 or later (`--no-lazy-fetch`). This used to apply only to the review gate; it now applies to every write-capable run, and an older Git gives `unknown`.

Limits, reported or documented rather than handled:

- It reports changes made **during** the run, by anyone. Edits by the caller, another agent, or another Codex run in the same working tree are attributed to the run. One write-capable run per working tree avoids this.
- A file changed and restored within the run shows no change. That is the intended result for mutation tests.
- Ignored files, `.git` contents, and files outside the working tree (scratch directory, `/tmp`) are not covered.
- Repositories with submodules or files using a Git filter, and directories outside Git, produce `unknown: <reason>`.
- Baseline trees are unreferenced objects; `git gc` prunes them after its expiry (two weeks by default).
- Cost: `snapshot.ts` seeds its temporary index from `HEAD`, so `git add -A` rehashes every tracked file. On large repositories this may take seconds per snapshot. Its duration is unmeasured; measure it first, and if it is too slow, seed the temporary index from a copy of the user's index to reuse its stat data.

### Concurrent runs in several worktrees

Each run has its own run id, run directory, result file, scratch directory, and temporary index. Snapshots of worktrees of one repository write objects into the shared object store; Git writes objects by atomic rename, so concurrent writes are safe. Thread records are one file per thread, written atomically. The run log is appended with single `write` calls of one line each.

Not guarded: two runs in the same worktree (mixed change reports, see above) and two runs on the same thread (Codex's own history would interleave).

### Background execution

`codex-run` runs in the foreground of its process. The caller uses the Bash tool's `run_in_background`, which notifies on exit. When the task is stopped, the runner stops Codex's process group, reports `changes: unknown: interrupted` with the baseline id, deletes the scratch directory, and exits 128+n; a `reapError` instead exits 1 and leaves the scratch directory, as above.

Unverified: how long Claude Code waits after stopping a background task before it kills the runner itself. If it kills the runner first, the run's output ends early, which the caller sees.

### Run log

Each run that printed a run id appends one JSON line to `<state>/runs.jsonl`: run id, time, sandbox, whether a thread was continued, exit code, duration, changed-file count or, for `unknown`, a reason category (`not-git`, `snapshot-failed`, `interrupted`, `reap-error`), and snapshot durations. No prompt, result, path, or raw error text is written; snapshot errors can contain paths. It exists to measure D2 (see the test strategy).

## Plan layer

Claims derived from the purpose layer, as hypotheses. Each names its source and the test that checks it. Tests cover the contract the caller sees (exit codes, stdout lines, run id, change report, thread refusal, prompt bytes, option passthrough); test files are new unless noted. The test harness sets `XDG_STATE_HOME` to a temporary directory for every runner process, so tests never write into the developer's state directory.

- **H1.** When `bin/codex-run` is run through a symlink, the wrapper shall `exec` `scripts/codex-run.ts` of the same plugin version. Source: P1, D4. Test: `tests/entry.test.ts` runs the wrapper through a symlink. The real `PATH` behavior is checked manually (P1).
- **H2.** If `--prompt-file` is missing, relative, unreadable, or blank, `--cwd` is missing or not a directory, an option is unknown, or a positional argument is given, the runner shall exit 2 without starting Codex. `--help` shall exit 0 without starting Codex. Source: P1, D5. Test: `tests/runner.test.ts`, with the fake Codex logging no call.
- **H3.** The runner shall write the bytes of the given absolute prompt file to Codex's stdin unchanged and add no other prompt text. Source: P7, D5. Test: the fake Codex records stdin; compare with the file, which starts with `-` and contains quotes and newlines.
- **H4.** Where no `--read-only` is given, the argv shall contain `-s workspace-write` and `--add-dir <scratch>` before any `resume`; with it, `-s read-only` and no `--add-dir`; with `--thread`, the `resume ... <id> -` form; `--model` and `--effort` shall appear as `-m` and `-c model_reasoning_effort=...` only when given. Source: P3, P4, D8. Tests: `tests/runner.test.ts` with the fake Codex; `tests/cli-contract.test.ts` (adapted) against the pinned Codex parser for new and resumed runs in both sandboxes.
- **H5.** stdout shall start with `run: <id>`, carry `scratch: <path>` on write-capable runs and `thread: <id>` only when Codex reported a thread start, end with the status, result, sandbox, and change lines, in at most 8 lines plus 11 lines of change listing, and keep a path containing a newline on one escaped line; the run id shall match the run log line. Source: P2, D11. Test: fake Codex scenarios that succeed with a large message and 100 changed files, and that fail before the thread start.
- **H6.** When Codex succeeds, `<run dir>/result.md` shall equal what the fake Codex wrote to `-o` byte for byte; when the fake Codex emits an agent message and exits 0 without writing `-o`, the run shall exit 1 with no `result:` line. Source: P2, P7, D6. Test: `tests/runner.test.ts`.
- **H7.** When `--thread <id>` names a record of the same repository, from another worktree, the runner shall resume it; for a record of another repository or an unknown id, it shall exit 2 before starting Codex. Source: P3. Test: `tests/thread-store.test.ts` with two worktrees and a second repository. The real resume from one worktree into another is checked manually (P3).
- **H8.** When the fake Codex adds an untracked file, modifies a tracked one, and deletes another, the report shall list them as `A`, `M`, `D`, relative to the workspace root; when it modifies and restores a file, the report shall say `none`; outside Git, the report shall be `unknown: <reason>`. Source: P5. Test: `tests/changes.test.ts`.
- **H9.** Under `--read-only` the report shall be `not checked: read-only`. Source: D2, D3. Test: `tests/runner.test.ts`.
- **H10.** The change report shall never change the exit code: a run with changes exits 0, a failed Codex with changes exits 1, a stopped run exits 128+n with `changes: unknown: interrupted`, and a `reapError` exits 1 even after a signal, with `scratch left:` when a scratch directory exists. Source: D3, P10. Test: `tests/runner.test.ts`.
- **H11.** If `codex` is absent, the runner shall exit 3 with no `run:` line and no run directory; if Codex exits non-zero or without a final message, or the thread record cannot be written, it shall exit 1. Source: P9. Test: existing cases of `tests/adapter.test.ts`, moved to `tests/runner.test.ts`.
- **H12.** After a write-capable run that did not end with a `reapError`, the scratch directory that Codex received as `TMPDIR` shall no longer exist, or, if deletion failed, its path shall be printed as `scratch left:`; with `GIT_DIR` and `GIT_WORK_TREE` set in the test's environment, the fake Codex shall see neither, and the workspace root and snapshot shall come from `--cwd` (a linked worktree). Source: P6, D8. Test: the fake Codex logs `$TMPDIR` and its Git variables; the test checks the path, the variables, and the reported workspace root afterwards.

## What is removed and what is reused

Sizes are current line counts; new code is estimated.

Removed:

| Item                                                                                                                                                    | Size                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `commands/` (review, adversarial-review, rescue, setup, transfer)                                                                                       | 5 files                      |
| `skills/codex-prompting`, `skills/codex-result-handling`                                                                                                | 2 files                      |
| `prompts/`, `schemas/` (adversarial review and stop gate)                                                                                               | 4 files                      |
| `hooks/hooks.json`, `scripts/session-start-hook.ts`, `scripts/stop-review-gate-hook.ts`                                                                 | 50 + 467                     |
| `lib/transfer.ts`, `lib/review-render.ts`, `lib/stop-gate-output.ts`, `lib/stop-gate-state.ts`, `lib/gate-config.ts`, `lib/prompt.ts`                   | 374 + 150 + 97 + 83 + 53 + 6 |
| `lib/args.ts` (heredoc argument protocol), replaced by `parseArgs`                                                                                      | 165                          |
| From `lib/codex-exec.ts`: `runCodexSync`, used only by setup                                                                                            | about 10                     |
| From `lib/git.ts`: `hasUncommittedChanges`, `resolveCommit`, `detectDefaultBranch`                                                                      | about 40                     |
| From `lib/snapshot.ts`: `headTree`, `emptyTree`, `treeExists`, `sessionStartTree`                                                                       | about 35                     |
| From `lib/env.ts`: `setEnvVar` and the session variables                                                                                                | about 35                     |
| Tests: `adapter` (cases carried over move to `runner`), `hooks`, `stop-gate-output`, `stop-gate-state`, `transfer`, `review-render`, `commands`, `args` | about 2,050                  |

Reused:

| Module                                    | Use and change                                                                                                   | Size              |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------- |
| `lib/codex-exec.ts`                       | spawning, JSONL events, thread start callback, failure reason; gains an `env` option passed through to the spawn | 189, small change |
| `lib/process-group.ts`                    | staged stop of the process group; gains an `env` option passed to `spawn`                                        | 270, small change |
| `lib/snapshot.ts`                         | `takeSnapshot`                                                                                                   | about 225         |
| `lib/thread-store.ts`                     | rewritten without sessions, with the stricter repository rule                                                    | 104 to about 80   |
| `lib/git.ts`, `lib/env.ts`, `lib/json.ts` | common directory, canonical paths, atomic writes                                                                 | about 110         |

New: `scripts/codex-run.ts` (replaces `codex.ts`, 587 lines, with about 280), `lib/changes.ts` (diff of two snapshots and the report, about 90), run directory, pruning, and run log (about 70), `bin/codex-run` (about 5). `scripts/` goes from about 3,100 lines to about 1,350.

README, plugin and marketplace descriptions, and the changelog are rewritten for the new surface in the same change. The README states the Git 2.45 requirement for the change report.

## Open decision: mutation tests in the caller's dirty working tree

Reviewers break code, run tests, and restore it. The caller's working tree usually has uncommitted work. Where should that happen?

**A. Same working tree, with the change report (recommended start).** Codex runs in `--cwd` as today; the report lists what changed and names the baseline tree.

**B. Disposable worktree from the snapshot.** The runner adds a detached worktree, writes the baseline snapshot's contents into it, runs Codex there, and removes it afterwards. Codex 0.169.0 also has `exec --worktree` ("run the session in a new managed Git worktree"); whether it carries uncommitted changes is unverified, so the snapshot step is likely still needed.

|               | A: same tree + report                                                                                                                                                                                                                                                                                         | B: disposable worktree                                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gains         | Codex sees exactly the caller's state, including ignored files that tests need (dependencies, build outputs); paths in findings match the caller's tree; nothing to set up; threads keep a stable directory across rounds.                                                                                    | The caller's tree cannot be changed by the run; failed restores and stray edits cost nothing; concurrent runs in one repository are isolated by construction.                                                                                                                           |
| Losses        | A failed restore or a stray edit lands in the caller's tree. It is detected, not prevented, and repairing it is the caller's job: only the caller knows which current content it means to keep. Ignored files and normalized bytes are not covered. Edits by others during the run are mixed into the report. | Ignored files are absent, so tests usually need a dependency install or build per run; paths in findings point into a deleted directory; each round of a thread runs in a fresh directory, so state from the previous round is gone; cleanup on interruption leaves worktrees to prune. |
| Reversibility | Adding B later is additive (`--isolate`), and the caller contract does not change.                                                                                                                                                                                                                            | Removing B later is also easy; both live inside the runner.                                                                                                                                                                                                                             |
| Cost          | The two snapshots the report needs anyway.                                                                                                                                                                                                                                                                    | About 150 to 250 more lines, a full checkout per run, and per-repository setup to make tests runnable.                                                                                                                                                                                  |

Recommendation: A. The report makes a mistake visible right after the run, and B's main cost (no ignored files, so tests do not run without setup) hits exactly the mutation tests it is meant to protect.

Change the recommendation when the run log, joined with the caller's notes, shows over a month of use that write-capable runs whose request forbade edits end with changes more than rarely (as a starting threshold, 2% of such runs), or any case where the caller lost uncommitted work. Then add `--isolate` (B) as an opt-in for review rounds, or revisit the read-only default (D2).

## Required changes on the caller side

The caller's review method (outside this repository) needs these changes. This plugin does not edit it.

1. The instruction to run the rescue command with `--read-only --prompt-file <file>` and to continue with `--thread <id>` becomes `codex-run --prompt-file <absolute file> [--read-only] [--thread <id>] --cwd <worktree>`, run in the background; read the result from the printed `result:` path.
2. The instruction to have Codex delete temporary files with `find <dir> -delete` in a freshly created dedicated directory, kept apart from the request and inputs, is obsolete. Replace it, in write-capable requests that run probes, with: put scratch files under `$TMPDIR`, which the runner removes, and print the absolute directory used. The caller compares that directory with the printed `scratch:` path; a mismatch, or a `scratch left:` line, means the caller cleans up (after a `reapError`, only once it has confirmed Codex's processes are gone), and repeated mismatches mean bringing the old instruction back.
3. Calls through the versioned cache path and the heredoc with a nonce are obsolete, as are permission rules for those paths; one `Bash(codex-run:*)` rule replaces them.
4. Redirecting stdout to a file is obsolete; the result is already a file and stdout is short.
5. New: note each run's printed run id with whether the request allowed edits. After each run, read the `changes:` line; on a round whose request said not to edit, a non-empty report is a finding to inspect before anything else touches the tree. What to restore, and how, is the caller's decision; the report gives only the paths and the baseline tree id.
6. New: requests for mutation tests or probes state that the tree must be restored before finishing.
7. Unchanged, because roles belong to the caller: "Codex reviews and does not implement", "say in the request that Codex must not edit", model and effort choice, the request format, and the neutral wording rule.

## Test strategy and what to measure

- Unit and integration tests run against the existing fake Codex (`tests/fixtures/fake-codex.ts`), extended with scenarios that write and restore files, log `$TMPDIR`, fail before the thread start, and emit large messages. The hypotheses above map one to one onto tests; edge cases the caller would notice in the output get no test of their own. `tests/helpers.ts` sets `XDG_STATE_HOME` for every spawned runner.
- `pnpm run test:cli-contract` keeps checking the argv against the pinned Codex parser, now for new and resumed runs in both sandboxes.
- A regression test counts only after it failed with the behavior removed and passed with it restored; the change report (H8), the thread refusal (H7), and the scratch cleanup (H12) are the ones to check this way.
- Before release, the purpose layer is checked on the real Claude Code and Codex CLI with the steps listed in P1 to P10, including the unverified `bin/` and scratch-directory items and the manual resume from one worktree into another (P3).

Measure, from the run log joined by run id with the caller's notes:

- the share of write-capable runs with a non-empty change report among those whose request forbade edits; `unknown` reports are counted separately and stay out of the denominator;
- `unknown` reports by reason;
- snapshot duration (median and maximum);
- the share of runs that still pass `--read-only`.

## Inventory: the same problem elsewhere

Places where the plugin decides a role or a method that belongs to the caller. All are removed or rewritten by this design.

- `skills/codex-prompting/SKILL.md`: tells the caller to drop output formats and its own diagnosis and to use the review commands for reviews, contradicting the caller's method.
- `skills/codex-result-handling/SKILL.md`: tells Claude to stop after review findings and wait for the user, and not to finish a failed task itself; caller policy.
- `commands/rescue.md`: its description ("hand a task to Codex when you are stuck") is visible to the model and invites delegating implementation; the command says Codex may edit by default because rescue meant implementation.
- `commands/review.md`, `commands/adversarial-review.md`, `prompts/adversarial-review.md`, `schemas/review-output.schema.json`, `lib/review-render.ts`: a reviewer role, its prompt, and its output shape.
- `prompts/stop-review-gate.md`, `schemas/stop-gate.schema.json`, `scripts/stop-review-gate-hook.ts`: a reviewer role plus a blocking policy over the caller's turn.
- The continue hint in `codex.ts` (`Continue: /codex:rescue --thread ...`) and the exit 3 message (`Run /codex:setup`): point to role commands.
- `README.md`, `plugin.json`, `marketplace.json`, and `package.json` descriptions: "review code or delegate tasks".
- `tests/commands.test.ts`: fixes the five role commands as a contract.

No role remains in `codex-exec.ts`, `process-group.ts`, `snapshot.ts`, or `thread-store.ts`; they are mechanism only and carry over.
