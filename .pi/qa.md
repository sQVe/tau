# QA guide

Tau ships Pi extensions, skills, and hand-run scripts. A `qa` worker can test the scripts. It cannot
test anything that runs inside a Pi session.

## Choose sections

| Section | Test it when the change touches                                               |
| ------- | ----------------------------------------------------------------------------- |
| Scripts | `pnpm token-usage`, `pnpm session-health`, or their entries in `package.json` |

Cross-effects:

- `src/errors.ts` and `src/schema.ts`: the scripts import them, so a change there needs "Scripts".
- A change to how a script reads session logs or worker records needs "Scripts". A change to the
  code that writes them is in "Not testable".

- A change to anything else under `src/`, to another script under `scripts/`, to `shell/`, or to
  the `package.json` `pi` manifest needs no `qa` launch. See "Not testable".
- When the impact on a section is unclear, include the section.

## Rules for every section

- The scripts read the session logs and worker records under `~/.pi/agent/` and write nothing. No
  section needs a data write.
- Test only the scripts the change affects, directly or through a file they import.
- Never run `pnpm smoke:pi`, `pnpm mutation`, `pnpm changeset`, `pnpm changeset:version`, or
  `pnpm release:github`. The first starts Pi and costs model turns. The others change tracked files
  or tags, or run for minutes.

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

## Not testable

Report these as not verified. Never try them through another path. When only this part applies to a
change, launch no `qa` worker. Report that QA did not run and name the reason.

- A `qa` worker cannot type into a Pi session. Tau blocks `hc send` and `hc keys` in every session
  and worker, so only the user can type.
- The worker itself runs the Tau checkout of the session that launched it. That is the user's
  installed checkout, not this worktree.
- No Pi session loads Tau from this worktree unless the user starts one with the steps of
  [Try Tau](../docs/development.md#try-tau).
- Without such a session, the installed checkout wrote every session log and worker record that
  the scripts read. A change to the code that writes them then shows in no script run here.
- The other scripts under `scripts/` have no command that a `qa` worker may run.
- GitHub and Linear have no sandbox, so no write to them is testable.

The user checks rendering, keys, and live network access with the
[manual check](../docs/development.md#manual-check), and runs the
[smoke test](../docs/development.md#smoke-test-in-pi) before a release and after a Pi upgrade.
