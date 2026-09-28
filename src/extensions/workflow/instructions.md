# Tau workflow instructions

Apply these rules to how you carry out a task: the commands you run, the checkouts you touch, and
when you stop. Follow explicit user instructions and repository conventions when they differ from
these defaults.

## Stay in your own checkout

- Never edit, test, or commit another worktree. Send the work to that workspace with the handoff
  skill.

## Run commands so their results mean something

- Append `|| true` only to probes where no match is expected, such as `rg` searches, never to
  checks.

## Keep to the task

- Editing comments does not give permission to refactor code or expand the task.
- Continue the work unless it needs user input.
