# Codex plugin for Claude Code

`codex-run` is a role-free executable in the plugin's `bin/` directory that Claude Code adds to the Bash tool's `PATH`. It runs one `codex exec` turn from a prompt file in a chosen working directory, writes Codex's final message unchanged to a per-run file, and prints a short summary report to stdout including any working-tree changes. The caller—typically an orchestrating Claude Code session—owns the role, prompt structure, and what to do with the result.

## Requirements

- **Node.js 24.2 or later.** The runner is written in TypeScript and uses Node's built-in type stripping and `import.meta.main`, with no runtime dependencies.
- **Codex CLI**, on `PATH` and logged in. Install it with `npm install -g @openai/codex`, then run `codex login`. Codex usage counts toward your ChatGPT plan or API key limits.
- **Git 2.45 or later** for the working-tree change report (uses `--no-lazy-fetch`; older Git versions report `changes: unknown: ...`).

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

Verify that `codex-run` is on the Bash tool's `PATH`:

```bash
codex-run --help
```

If Codex is not logged in yet, run `codex login`.

## Usage

Minimal call:

```bash
codex-run --prompt-file /abs/path/to/prompt.md --cwd /path/to/repo
```

### Options

```text
codex-run --prompt-file <absolute file> [--cwd <dir>] [--read-only] [--thread <id>]
          [--model <model>] [--effort <effort>]
codex-run --help
```

- `--prompt-file <file>`: Required. Must be an absolute path to a readable, non-blank file. Its bytes are sent to Codex on stdin unchanged.
- `--cwd <dir>`: Codex's working directory. Default: the current directory. Must exist and be a directory.
- `--read-only`: Run Codex in the `read-only` sandbox instead of the default `workspace-write`.
- `--thread <id>`: Continue a thread started by `codex-run` in the same repository.
- `--model <model>`: Pass `-m <model>` to Codex unchanged.
- `--effort <effort>`: Pass `-c model_reasoning_effort=<effort>` to Codex unchanged.
- `--help`: Show usage and exit `0`.

Options are parsed strictly as long options only; there are no short options and no positional arguments. Repeating an option keeps its last value.

### Stdout report

```text
run: 20260101T000000Z-a1b2c3d4
scratch: /tmp/codex-run-scratch-xxxxxx
thread: 0195f3a2-7c00-7000-8000-000000000000
status: ok (exit 0)
result: <state>/runs/20260101T000000Z-a1b2c3d4/result.md
sandbox: workspace-write  cwd: /path/to/repo
changes: none
```

- `run: <id>`: Always printed first. Format is `<UTC timestamp>-<8 hex chars>`.
- `scratch: <dir>`: Write-capable runs only, printed before Codex starts. Names the temporary directory passed to Codex as `TMPDIR` and `--add-dir`.
- `thread: <id>`: Printed as soon as Codex reports `thread.started`. Omitted if Codex exits before reporting a thread.
- `status: ok|failed|interrupted (exit <n>)`: Final status (`ok` for exit `0`, `interrupted` for exit `> 128`, `failed` otherwise) and exit code.
- `result: <file>`: Printed on exit `0` only. Path to `result.md` in the run directory.
- `sandbox: <mode>  cwd: <dir>`: Effective sandbox (`workspace-write` or `read-only`) and resolved `--cwd`.
- `changes: ...`: Working-tree change report (see [Change report](#change-report)).
- `scratch left: <dir>`: Printed only when a scratch directory was created and was not deleted (deletion failed, or deletion was skipped because Codex's process group could not be confirmed gone).

Output without a `status:` line, or a write-capable run without a `changes:` line, is incomplete. Backslashes and control characters in printed paths and messages are escaped (`\\`, `\n`, `\t`, `\xNN`) so each line stays on one line.

On failure, stderr prints `codex-run: <one-line summary>` followed by up to 40 cleaned lines of Codex's stderr.

### Result file

Codex writes its final assistant message via `-o` to `<state>/runs/<run id>/result.md`. `codex-run` does not modify or reformat the file. Each run gets its own private directory (`0700`), so concurrent runs do not overwrite each other's output.

If Codex exits `0` without writing a non-empty `result.md`, `codex-run` exits `1` and omits `result:`.

Run directories older than 7 days (by modification time) are pruned automatically on subsequent runs.

### Threads

When Codex reports `thread.started`, `codex-run` writes `<state>/threads/<thread id>.json` containing `{cwd, repo, updatedAt}`, where `cwd` is the canonical workspace root and `repo` is the canonical Git common directory (`null` outside Git).

`--thread <id>` is accepted only when `<id>` matches `^[A-Za-z0-9-]{1,128}$`, a record exists in the thread store, and:

- **Inside Git:** the current `--cwd` shares the same Git common directory (`repo`). Any worktree of that repository matches; a Git record never matches by path alone.
- **Outside Git:** the current `--cwd` is also outside Git and has the exact same canonical path.

Otherwise `codex-run` exits `2` before starting Codex: an invalid id is rejected outright, an unknown id suggests `codex resume <id>` in a terminal, and a mismatched repository or directory names the recorded location and suggests `--cwd` in that repository or `codex resume <id>` in a terminal.

Thread records are not scoped to a Claude Code session. Concurrent runs on the same thread are not guarded; keep rounds of a thread sequential.

### Sandbox and Codex configuration

The default sandbox is `workspace-write`, allowing Codex to run probe scripts, tests, and file edits inside the workspace. Pass `--read-only` to run Codex in the `read-only` sandbox; read-only runs skip working-tree snapshots and do not create a scratch directory.

`codex-run` uses the `codex` binary on `PATH` and Codex's own configuration (`~/.codex/config.toml` and trusted project-level `.codex/config.toml`). Every run passes `-c approval_policy="never"`, `-c approvals_reviewer="user"`, and `--skip-git-repo-check`. `--model` and `--effort` are forwarded only when specified.

Repository-selection Git environment variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`) are stripped from both the runner's Git calls and Codex's environment so Git resolves the repository from `--cwd` (the snapshot's own Git calls set a temporary `GIT_INDEX_FILE` for the snapshot index).

### Change report

On write-capable runs, `codex-run` snapshots the workspace root of `--cwd` as a Git tree in a temporary index before Codex starts and again after its process group exits, then compares the two trees with `git diff-tree -r -z --no-renames --name-status`. Snapshots do not touch the user's index, refs, or working tree, and disable hooks, fsmonitor, untracked cache, lazy fetch, and filter drivers.

Possible `changes:` values:

- `none`: The baseline and final snapshots are equal as Git stores them.
- `<n> files (baseline <tree>, paths relative to <workspace root>)`: Lists up to 10 changed paths as `  <status> <path>` (`A`, `M`, `D`, `T`, etc.). When more than 10 files changed, the full list (`baseline <tree>`, `final <tree>`, then `<status>\t<path>` lines) is written to `<state>/runs/<run id>/changes.txt` and referenced as `  ... full list: <file>`.
- `unknown: <reason>` (with `(baseline <tree>)` when a baseline exists): The workspace is outside Git, a snapshot or diff failed (for example Git older than 2.45, submodules, files with a Git `filter` attribute, or a 30-second snapshot timeout), the run was interrupted by a signal, or Codex's process group could not be confirmed gone.
- `not checked: read-only`: The run used `--read-only`.

The change report never changes the exit code.

Limits:

- Reports all working-tree changes that occurred **during** the run, including edits made by other processes in the same working tree. Run at most one write-capable `codex-run` per working tree at a time; concurrent runs in separate worktrees are isolated.
- Changes made and reverted before Codex exits report `none`.
- Byte changes hidden by Git normalization on `git add` (such as line endings under `core.autocrlf`) report `none`.
- Ignored files, `.git` contents, and files outside the working tree are not covered. This includes a file that matches an ignore rule and was tracked with `git add -f` but is not in `HEAD`: its edits report `none`, because the temporary index starts from `HEAD` and `git add -A` skips ignored paths.
- Sparse checkouts are untested.
- Repositories with submodules (or embedded repositories) and files with a Git `filter` attribute (such as Git LFS) produce `unknown: <reason>`.
- Snapshot trees are unreferenced Git objects that `git gc` prunes after its expiry period.

### Scratch directory and `TMPDIR`

On write-capable runs, after taking the baseline snapshot, `codex-run` creates a temporary directory (`codex-run-scratch-*` under the system temporary directory), passes it to Codex via `--add-dir` and `TMPDIR`, and prints `scratch: <dir>`.

After Codex's process group exits, `codex-run` deletes the directory after verifying its device and inode still match what was created. If deletion fails, or if Codex's process group could not be confirmed gone (so Codex may still be using it), the directory is left in place and reported as `scratch left: <dir>`.

Limit: Codex's `shell_environment_policy` controls the environment of its shell tool and may drop or override `TMPDIR`.

### Exit codes

| Code    | Meaning                                                                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`     | Codex finished the turn with a non-empty final message.                                                                                                                                                             |
| `1`     | Codex failed, finished without a final message, a Git lookup failed before starting, the thread record could not be written, or Codex's process group could not be confirmed gone (takes precedence over a signal). |
| `2`     | Usage error (missing, relative, unreadable, or blank `--prompt-file`; invalid `--cwd`; unknown option; positional argument) or refused `--thread`. Codex was not started.                                           |
| `3`     | `codex` was not found on `PATH`.                                                                                                                                                                                    |
| `128+n` | Stopped by signal `n` (`130` for `SIGINT`, `143` for `SIGTERM`).                                                                                                                                                    |

### Running in the background

`codex-run` runs in the foreground of its own process. For long runs, use Claude Code's Bash tool background mode (`run_in_background`); stdout stays short so the completion notification is concise.

When stopped with `SIGINT` or `SIGTERM`, `codex-run` terminates Codex's entire process group in stages (`SIGINT`, `SIGTERM`, `SIGKILL`) and exits `128+n`; on write-capable runs it reports `changes: unknown: interrupted` (with the baseline tree id if taken) and deletes the scratch directory, while a stopped `--read-only` run reports `changes: not checked: read-only` and has no scratch directory. If the process group cannot be confirmed gone, it exits `1` and, on write-capable runs, leaves the scratch directory (`scratch left: <dir>`).

### State directory and run log

`<state>` is `$XDG_STATE_HOME/codex-plugin-cc`, or `~/.local/state/codex-plugin-cc` when `XDG_STATE_HOME` is unset, empty, or relative.

```text
<state>/
  runs/<run id>/result.md     # Codex's -o output (pruned after 7 days)
  runs/<run id>/changes.txt   # Written only when more than 10 files changed
  threads/<thread id>.json    # {cwd, repo, updatedAt}
  runs.jsonl                  # One metadata JSON line per run
```

Each run that prints `run: <id>` appends one JSON line to `<state>/runs.jsonl` with:

- `run` (run id), `time` (ISO-8601 UTC start time), `sandbox`, `continued` (boolean), `exit`, `durationMs`
- `changes` (changed-file count, or `null` when `read-only` or `unknown`)
- `unknown` (present when `changes:` is `unknown`: `not-git`, `snapshot-failed`, `interrupted`, or `reap-error`)
- `snapshotMs` (present on write-capable runs: `{ baseline, final? }`)

`runs.jsonl` does **not** record prompts, results, file paths, or raw error text.

## Permissions

Add a Claude Code Bash permission rule to allow `codex-run` across plugin updates without referencing versioned cache paths:

```text
Bash(codex-run:*)
```

## Development

The tools are pinned in `mise.toml`. After cloning, run `mise install`, then `pnpm install` and `pnpm exec lefthook install` to set up the dependencies and git hooks.

The GitHub repository settings are declared in `.github/infra.yaml`; review them with `mise exec -- gh-infra plan .github/infra.yaml` then apply them with `gh-infra apply` on the same file.

```bash
pnpm run lint
pnpm run fmt
pnpm run typecheck
pnpm test
pnpm run test:cli-contract   # checks the plugin's argv against the pinned Codex CLI, without network access
```

## License

Apache-2.0. This project started as a fork of OpenAI's Codex plugin for Claude Code. See `LICENSE` and `NOTICE`.
