# Tau workflow instructions

Apply these rules to how you carry out a task: the commands you run, the checkouts you touch, and
when you stop. Follow explicit user instructions and repository conventions over these defaults.

## Stay in your own checkout

- Never edit, test, or commit another worktree.
- Never discard uncommitted changes you did not make. To set your own work aside, commit it instead
  of stashing.

## Resolve terminal addresses first

- An address such as `t28` names an `hc` terminal. Before searching files, branches, worktrees, or
  Linear, run `hc get t28` and use its `cwd` and labels.

## Open herdr-app panes beside your own

- Before a `herdr-app` pane command, find your pane in `herdr-app ls` by `HC_TERMINAL_ID` and pass
  it as `pane`. The default is the focused pane, which may be in another space.
- Start a terminal in a folder with
  `pane.split --direction right --pane <your pane> --argv '["env","-C","<folder>","<program>"]'`,
  not `terminal.open`, which splits the focused pane.
- Before you report where it runs, check that `hc get <new terminal>` shows your `herdr.space` label
  and the folder in `foreground.cwd`.

## Run commands

- Append `|| true` only to probes where no match is expected, such as `rg`, never to checks.
- Save a long check's output to a file. Do not rerun a check only to see output you cut off.
- When a check, test, or tool run fails, read all of its output, not only the tail.
- Call a failure unrelated or pre-existing only after you reproduce it on the base or cite the log
  line showing its cause outside this change. Until then it is unexplained.
- Run commands non-interactively: pass every value a prompt would ask for and set `GIT_EDITOR=true`
  for `git rebase --continue`.

## Keep to the task

- Editing comments does not permit refactoring or scope growth.
- Continue the work unless it needs user input.
- Do not end a turn that waits for the user without stating the question.
- While you follow a skill, ask the user only with `ask_user_question`, never in prose.
- As manager, start a new session when a batch is finished and no workers run. Carry state in
  handover files and Linear, not the conversation.
- As manager, when the user corrects you, fix the mistake, save it with `improvement` `record`, and
  propose a rule or check for the user to approve.

## Rule table

The prose above is authoritative. Rules without a check are owned by the human reviewer.

| Rule                  | Enforced by                              |
| --------------------- | ---------------------------------------- |
| Shared workflow rules | [stomme](https://github.com/sQVe/stomme) |
