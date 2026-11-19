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

## Open herdr-app terminals in a new tab

- Read your space from the `herdr.space` label of `hc get $HC_TERMINAL_ID`.
- Start a terminal with
  `herdr-app do tab.new --space <your space> --folder <folder> --argv '["<program>"]'`. It names the
  space. Do not use `pane.split` in the lead's tab: it adds a pane to the tab it splits, and the
  lead's tab holds only the architect and the lead.
- Give a new space its task when you start it, through the `architect` `open` `request` or the
  `handover` `start` file. Never start a space empty and send the task later, and never open the
  architect with no topic.
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

## Verify a tool's capability and effect

- Before saying a tool cannot do something, read the loaded tool's current schema or its help
  output. A running subagent worker can get more input mid-task: the `handover` `send` action
  reaches a live Pi session's inbox by terminal address.
- Before relying on a tool parameter, read the loaded tool's current schema. A loaded tool that
  predates a parameter drops it without an error, so the call does something other than what you
  asked.
- After a call, check the effect it produced, such as a started process's argv or its model name,
  instead of assuming the arguments were used.

## Keep to the task

- Editing comments does not permit refactoring or scope growth.
- When you find a defect, fix it at its cause in its own space. If you cannot fix it now, file a bug
  ticket. Never leave the defect as an out-of-scope note or a workaround.
- When a check fails, fix its cause, or file a bug ticket when you cannot fix it now. Never skip the
  check or cap its resources, such as memory or a mutant count, to hide the cause.
- Continue the work unless it needs user input.
- Do not end a turn that waits for the user without stating the question.
- While you follow a skill, ask the user only with `ask_user_question`, never in prose.
- As manager, start a new session when a batch is finished and no workers run. Carry state in
  handover files and Linear, not the conversation.
- As manager, when a space blocks on a question, restart it with the answer in its start brief. If
  you do not know the answer, ask the user with `ask_user_question` first. Never guess the answer.
- As manager, restart an ordinary handover session in a new tab. Send the answer to a running
  architect with `handover` `send`. Once a blocked architect stops, reopen it with `architect`
  `open` and the answer in its `request`, so it resumes its saved session instead of starting cold.
- As manager, when the user corrects you, fix the mistake, save it with `improvement` `record`, and
  propose a rule or check for the user to approve.
- As manager, do the work you can do instead of handing it back to the user. Fix a bug you find
  right away in its own space, not only as a backlog ticket. Make the tracker status change you can
  make, such as moving a slice to In Progress. Treat a proposal the user has effectively accepted as
  decided and do not ask again.

## Rule table

The prose above is authoritative. Rules without a check are owned by the human reviewer.

| Rule                  | Enforced by                              |
| --------------------- | ---------------------------------------- |
| Shared workflow rules | [stomme](https://github.com/sQVe/stomme) |
