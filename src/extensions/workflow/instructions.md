# Tau workflow instructions

Apply these rules to how you carry out a task: the commands you run, the checkouts you touch, and
when you stop. Follow explicit user instructions and repository conventions when they differ from
these defaults.

## Stay in your own checkout

- Never edit, test, or commit another worktree.
- Never discard uncommitted changes you did not make. To set your own work aside, commit it instead
  of stashing.

## Resolve herdr IDs first

- An ID like `wMJ` names a herdr workspace, `wMJ:p1` a pane, and `wMJ:t1` a tab.
- Run `herdr workspace get <id>` before you search files, branches, worktrees, or Linear. Its
  `worktree.checkout_path` is the workspace checkout, and `tokens.linear` is its ticket.
- Run `herdr pane list --workspace <id>` and `herdr pane read <pane-id>` to see what its panes hold.
- You may read files in that checkout. Make changes there through the handoff skill.

## Run commands

- Append `|| true` only to probes where no match is expected, such as `rg` searches, never to
  checks.
- Save the output of a long check to a file and read failures from it. Do not rerun a check only to
  see output you cut off.
- Run commands so they never wait for input. Pass every value a prompt would ask for, and set
  `GIT_EDITOR=true` for `git rebase --continue`.

## Keep to the task

- Editing comments does not give permission to refactor code or expand the task.
- Continue the work unless it needs user input.
- Do not end a turn that waits for the user without stating the question.
- As a manager, start a new session when a batch of work has finished and no workers are running.
  Carry state through handoff files and Linear, not the conversation.
