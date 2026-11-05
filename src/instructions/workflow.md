# Tau workflow instructions

Apply these rules to how you carry out a task: the commands you run, the checkouts you touch, and
when you stop. Follow explicit user instructions and repository conventions when they differ from
these defaults.

## Stay in your own checkout

- Never edit, test, or commit another worktree.
- Never discard uncommitted changes you did not make. To set your own work aside, commit it instead
  of stashing.

## Resolve terminal addresses first

- An address such as `t28` names an `hc` terminal. Before you search files, branches, worktrees, or
  Linear, run `hc get t28` and use its `cwd` and labels.

## Run commands

- Append `|| true` only to probes where no match is expected, such as `rg` searches, never to
  checks.
- Save the output of a long check to a file and read all of its failures, not only the tail. Do not
  rerun a check only to see output you cut off.
- Call a failure unrelated or pre-existing only after you reproduce it on the base or cite the log
  line that shows its cause. Until then, it is unexplained.
- Run commands so they never wait for input. Pass every value a prompt would ask for, and set
  `GIT_EDITOR=true` for `git rebase --continue`.

## Keep to the task

- Editing comments does not give permission to refactor code or expand the task.
- Continue the work unless it needs user input.
- Do not end a turn that waits for the user without stating the question.
- While you follow a skill, ask the user only with `ask_user_question`, never in prose.
- As a manager, start a new session when a batch of work has finished and no workers are running.
  Carry state through handover files and Linear, not the conversation.
