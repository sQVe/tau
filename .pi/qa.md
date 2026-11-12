# QA guide

Tau ships Pi extensions, skills, and hand-run scripts. A `qa` worker can test the scripts. It can
test behavior inside a Pi session with `pnpm pi-session`, but not the terminal user interface.

## Choose sections

| Section     | Test it when the change touches                                               |
| ----------- | ----------------------------------------------------------------------------- |
| Scripts     | `pnpm token-usage`, `pnpm session-health`, or their entries in `package.json` |
| Pi sessions | Anything else under `src/`, or the `package.json` `pi` manifest               |

Cross-effects:

- `src/errors.ts` and `src/schema.ts`: the scripts import them, so a change there needs "Scripts".
- A change to how a script reads session logs or worker records needs "Scripts". A change to the
  code that writes them needs "Pi sessions".
- A change to behavior that launches workers needs "Pi sessions", and the manager runs its
  worker-launch recipe. Launch no `qa` worker for that behavior.

No launch, and unclear impact:

- A change to another script under `scripts/` or to `shell/` needs no `qa` launch. So does a change
  that shows only in the terminal user interface. See "Not testable".
- When the impact on a section is unclear, include the section.

## Before a launch

The manager starts nothing. For "Pi sessions", the brief must give these two lines:

- `Model runs allowed`. A session costs model tokens. Without this line, the worker runs no session
  and asks the parent.
- `Model: <pattern>`. It names a cheap model, and the worker passes it as `--model`.

## Rules for every section

- The scripts read the session logs and worker records under `~/.pi/agent/` and write nothing. A Pi
  session writes in its scratch working directory and in temporary directories. No section needs a
  data write in this worktree.
- Test only the scripts the change affects, directly or through a file they import.
- Run `pnpm pi-session` only for "Pi sessions", because it starts Pi and costs model turns.
- Never run `pnpm smoke:pi`, `pnpm mutation`, `pnpm changeset`, `pnpm changeset:version`, or
  `pnpm release:github`. The first is the release check and costs model turns. The others change
  tracked files or tags, or run for minutes.

## Scripts

### Reach it

Run each command in this worktree. Node runs the TypeScript source directly, so the commands always
serve this worktree. Nothing needs to run first.

```sh
git rev-parse --show-toplevel
```

It must print the worktree path that the brief names. If it prints another path, stop and ask the
parent.

### Use it safely

```sh
pnpm token-usage --since 1d --top 3
pnpm session-health --since 1d
```

### What to check

`pnpm` first prints the `node` command it runs. The script output starts on the next line.

- `pnpm token-usage` prints the window on the first line of its output and the count of skipped
  records on the second. Tables for tokens, turns, top sessions, and tool output follow.
- `pnpm session-health` prints the window, then the count of session files, then the failed rules,
  then one table per UTC day. An empty window prints `None` under the failed rules.
- A bad option or time exits with code 1 and names the bad value.

## Pi sessions

### Reach it

Run `pnpm pi-session` in this worktree, as the recipe below shows. It prints `Event log: <path>`.
Set `log` to that path, then run this proof after each session:

```sh
jq -r 'select(.type == "message_start" and .message.role == "system")
  | .message.sections.skills | [scan("<location>([^<]*)/src/skills/")[]] | unique[]' "$log"
```

It must print one line, the worktree path that the brief names. If it prints anything else, stop
and ask the parent.

### Use it safely

- Give `--cwd` a new scratch directory under `/tmp`, never a worktree.
- Pass the brief's model as `--model`, and `--timeout 300`.
- Send one prompt per session. Start it with the first two sentences of the recipe's prompt, so
  the session asks no question.
- A session that a worker starts has no `subagent` tool. Never ask it to launch a worker, and
  report such a check as not verified.

### What to check

- The command exits with code 0. A failed session exits with code 1 and prints a `FAIL` line.
- The tools the session called, each with its error flag:

  ```sh
  jq -c 'select(.type == "tool_execution_end") | [.toolName, .isError]' "$log"
  ```

- The text the session replied with:

  ```sh
  jq -r 'select(.type == "message_end" and .message.role == "assistant")
    | .message.content[] | select(.type == "text") | .text' "$log"
  ```

### Recipes

A `qa` worker runs this recipe, for behavior that launches no worker. Change the prompt after its
first two sentences to trigger the changed behavior.

```sh
scratch=$(mktemp -d /tmp/tau-qa-XXXXXX)
git -C "$scratch" init --quiet
pnpm pi-session --cwd "$scratch" --model <pattern> --timeout 300 --prompt 'This is an automated check with no user present. Never call ask_user_question. Run the bash command "echo SESSION-OK" once. Then reply with only the output of the command.'
```

As written, the tools check prints `["bash",false]` and the reply check prints `SESSION-OK`.

Only the manager runs the [worker-launch recipe](qa/pi-session-worker-launch.md), for behavior that
launches workers.

## Not testable

Report these as not verified. Never try them through another path. When only this part applies to a
change, launch no `qa` worker. Report that QA did not run and name the reason.

- `pnpm pi-session` shows no terminal user interface, so rendering, keys, and the statusbar are not
  testable.
- Nobody can type into a running Pi session. Tau blocks `hc send` and `hc keys` in every session
  and worker, and `pnpm pi-session` sends one prompt.
- The other scripts under `scripts/` have no command that a `qa` worker may run.
- GitHub and Linear have no sandbox, so no write to them is testable.

The [manual check](../docs/development.md#manual-check) covers rendering, keys, and live network
access. The [smoke test](../docs/development.md#smoke-test-in-pi) runs before a release and after a
Pi upgrade.
