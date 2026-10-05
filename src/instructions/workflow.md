# Tau workflow instructions

Apply these rules to how you carry out a task: the commands you run, the checkouts you touch, and
when you stop. Follow explicit user instructions and repository conventions when they differ from
these defaults.

## Stay in your own checkout

- Never edit, test, or commit another worktree.
- Never discard uncommitted changes you did not make. To set your own work aside, commit it instead
  of stashing.

## Resolve herdr IDs first

- An ID like `wMJ` names a herdr workspace, and `wMJ:p1` a pane in it. Before you search files,
  branches, worktrees, or Linear, run `herdr workspace get wMJ` with the workspace part only. It
  shows the workspace checkout and ticket.

## Run commands

- Append `|| true` only to probes where no match is expected, such as `rg` searches, never to
  checks.
- Save the output of a long check to a file and read failures from it. Do not rerun a check only to
  see output you cut off.
- Run commands so they never wait for input. Pass every value a prompt would ask for, and set
  `GIT_EDITOR=true` for `git rebase --continue`.

## Gather evidence with codemode

- When the `codemode` tool is available, use it to gather evidence. Without it, skip this section.
- Plan one script per evidence set.
- Keep raw output out of context. Return bounded, line-numbered excerpts with command status and
  gaps.
- Cite only what the script returned. If a fact was filtered out, gather and return it before citing
  it.
- Never call report, question, progress, or orchestration tools from a script.

## Keep to the task

- Editing comments does not give permission to refactor code or expand the task.
- Continue the work unless it needs user input.
- Do not end a turn that waits for the user without stating the question.
- As a manager, start a new session when a batch of work has finished and no workers are running.
  Carry state through handoff files and Linear, not the conversation.
