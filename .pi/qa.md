# QA guide

Tau ships Pi extensions, skills, and hand-run scripts. A `qa` worker can test the scripts. It can
test behavior inside a Pi session with `pnpm pi-session`, but not the terminal user interface.

Three exceptions: the manager runs the [worker-launch feature](qa/features/pi-session-worker-launch.md),
the [question gate shadow feature](qa/features/question-gate-shadow.md) sessions, and the
[question gate decide feature](qa/features/question-gate-decide.md) sessions; a `qa` worker only
checks their saved output and records the result.

## Choose sections

| Section     | Test it when the change touches                                               |
| ----------- | ----------------------------------------------------------------------------- |
| Scripts     | `pnpm token-usage`, `pnpm session-health`, `pnpm question-gate-score`, or their entries in `package.json` |
| Pi sessions | Anything else under `src/`, or the `package.json` `pi` manifest               |

Cross-effects:

- `src/errors.ts` and `src/schema.ts`: the scripts import them, so a change there needs "Scripts".
- A change to how a script reads session logs or worker records needs "Scripts". A change to the
  code that writes them needs "Pi sessions".
- A change to behavior that launches workers needs "Pi sessions". The manager runs its
  [worker-launch session](qa/features/pi-session-worker-launch.md) and a `qa` worker records it.
- A change to the question gate sampling rule, the shadow record, or `ask_user_question` needs
  "Pi sessions". The manager runs its
  [question gate shadow session](qa/features/question-gate-shadow.md) and a `qa` worker records it.
- A change to decide mode, the decision record, or the `decided` result needs "Pi sessions". The
  manager runs its
  [question gate decide session](qa/features/question-gate-decide.md) and a `qa` worker records it.

No launch, and unclear impact:

- A change to another script under `scripts/` or to `shell/` needs no `qa` launch. So does a change
  that shows only in the terminal user interface. See "Not testable".
- When the impact on a section is unclear, include the section.

## Journeys

| Journey | Goal | Run it when the change touches | Test |
| ------- | ---- | ------------------------------ | ---- |
| [Answer a handover question](qa/journeys/answer-a-handover-question.md) | Unblock a handover session while the user is away. | `src/extensions/handoverQuestion/`, `src/extensions/handover/`, `src/handoverSender.ts`, or the inbox family code in `src/inbox/` and `src/extensions/inbox/` | By hand |
| [Day token use](qa/journeys/day-token-use.md) | Learn where the last day's tokens went and whether the sessions were healthy. | `pnpm token-usage`, `pnpm session-health`, their `package.json` entries, `src/errors.ts`, `src/schema.ts`, or session-log and worker-record readers | By hand |
| [Delegate a check](qa/journeys/delegate-a-check.md) | Delegate a check to a `qa` worker and get its report. | Worker-launch behavior under `src/`, or the `package.json` `pi` manifest | By hand, manager and a `qa` worker |
| [Review a task at merge](qa/journeys/review-a-task-at-merge.md) | Learn from a task that went badly while it is fresh. | `src/extensions/mergeWatch/` or `src/improvement/` | By hand |
| [Run a slice with a lead](qa/journeys/run-a-slice-with-a-lead.md) | Take a slice from the first conversation to a pull request, with design on the architect and orchestration on the lead. | The lead and architect roles, the `architect` tool, role models, or role guidelines | By hand |
| [Run the correct pass](qa/journeys/run-the-correct-pass.md) | Turn mistakes that repeat across tasks into checks. | `src/skills/retrospective/`, `src/extensions/improvement/`, or `src/improvement/` | By hand |

## Features

| Feature | Section | Target | Update it when the change touches |
| ------- | ------- | ------ | --------------------------------- |
| [Prompt in a Pi session](qa/features/pi-session-prompt.md) | Pi sessions | `pi-session` | Behavior inside a session that launches no worker |
| [Worker launch in a Pi session](qa/features/pi-session-worker-launch.md) | Pi sessions | `pi-session` | Behavior that launches workers |
| [Question gate shadow record](qa/features/question-gate-shadow.md) | Pi sessions | `pi-session` | `ask_user_question`, the question gate sampling rule, or shadow records |
| [Question gate decide](qa/features/question-gate-decide.md) | Pi sessions | `pi-session` | decide mode, the decision record, or the `decided` result |
| [Question gate shadow score](qa/features/question-gate-score-shadow.md) | Scripts | none | `pnpm question-gate-score --shadow` or its shadow report |

## Before a launch

The manager launches the `pi-session` target with the `verification` tool, and "Scripts" needs
nothing started because its target is `none`. For "Pi sessions", the brief must give two lines:

- `Model runs allowed`. A session costs model tokens. Without this line, the worker runs no session
  and asks the parent.
- `Model: <pattern>`. It names a cheap model, and the worker passes it as `--model`.

## Rules for every section

- The scripts read the session logs and worker records under `~/.pi/agent/` and write nothing. A Pi
  session writes in its scratch working directory and in temporary directories. No section needs a
  data write in this worktree. Test only the scripts the change affects, directly or through a file
  they import.
- Run `pnpm pi-session` only for "Pi sessions", because it starts Pi and costs model turns.
- Never run `pnpm smoke:pi`, `pnpm mutation`, `pnpm changeset`, `pnpm changeset:version`, or
  `pnpm release:github`. These cost model turns, or change tracked files or tags, or run for minutes.

## Scripts

Target: none

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
- `pnpm question-gate-score --limit 0` exits 1 and names `0`. It costs model calls, so check only
  argument errors.
- A bad option or time exits with code 1 and names the bad value.

## Pi sessions

Target: pi-session

`pnpm pi-session` loads Tau from this worktree's source, so the code under test is this checkout.
The launch creates the scratch root `/tmp/tau-verification-<run>`. The doctor checks the scratch
root, that `pi` runs, and, with `pnpm pi-version:check`, that the installed Pi has the minor
version Tau builds against. The stop keeps the scratch root.

### Reach it

Run `pnpm pi-session` in this worktree, as the feature files below show. It prints
`Event log: <path>`. Set `log` to that path, then run this proof after each session:

```sh
jq -r 'select(.type == "message_start" and .message.role == "system")
  | .message.sections.skills | [scan("<location>([^<]*)/src/skills/")[]] | unique[]' "$log"
```

It must print one line, the worktree path that the brief names. If it prints anything else, stop
and ask the parent.

### Use it safely

- Give `--cwd` a new directory under the scratch root, such as
  `mktemp -d "/tmp/tau-verification-<run>/qa-XXXXXX"` where `<run>` is the run name from the
  brief, never a worktree.
- Pass the brief's model as `--model`, and `--timeout 300`.
- Send one prompt per session. Start it with the first two sentences of the prompt in the feature
  file, so the session asks no question.
- A session that a worker starts has no `subagent` tool. Never ask it to launch a worker, and
  report such a check as not verified.

### What to check

- The command exits with code 0. A failed session exits with code 1 and prints a `FAIL` line.
- The text the session replied with:

  ```sh
  jq -r 'select(.type == "message_end" and .message.role == "assistant")
    | .message.content[] | select(.type == "text") | .text' "$log"
  ```

### Features

- [Prompt in a Pi session](qa/features/pi-session-prompt.md): a `qa` worker runs it, for behavior
  that launches no worker. Change the prompt after its first two sentences to trigger the changed
  behavior.
- [Worker launch in a Pi session](qa/features/pi-session-worker-launch.md): only the manager runs
  its session, for behavior that launches workers.
- [Question gate shadow record](qa/features/question-gate-shadow.md): only the manager runs its
  session, for `ask_user_question`, the question gate sampling rule, or shadow records.
- [Question gate decide](qa/features/question-gate-decide.md): only the manager runs its session,
  for decide mode, the decision record, or the `decided` result.

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
