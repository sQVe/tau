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
  `herdr-app do tab.new --space <your space> --folder <folder> --name "<role>: <task>" --argv '["<program>"]'`.
  It names the space and the tab. Use a new tab for other terminals. The lead's tab holds only the
  lead and architect; `architect` `open` puts the architect on the right.
- Name the tab in lowercase, at most 24 characters, with no ticket ID.
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
  ticket. Never leave the defect as an out-of-scope note or a workaround. After the lead's one fix
  review, use `triage-findings` instead of this rule.
- When a check fails, fix its cause, or file a bug ticket when you cannot fix it now. Never skip the
  check or cap its resources, such as memory or a mutant count, to hide the cause.
- Continue the work unless it needs user input.
- As lead, keep your plan current with `plan` while the work has steps, and clear it with an empty
  list when the user drops the work.
- Do not end a turn that waits for the user without stating the question.
- While you follow a skill, ask the user only with `ask_user_question`, never in prose.
- As manager, start a new session when a batch is finished and no workers run. Carry state in
  handover files and Linear, not the conversation.
- As manager, when a space blocks on a question, restart it with the answer in its start brief. If
  you do not know the answer, ask the user with `ask_user_question` first. Never guess the answer.
- As manager, end a blocked handover session with `hc kill <terminal>` before you restart it, and
  check with `hc get <terminal>` that its program ended. A live blocked session can continue in the
  same checkout once someone answers its dialog.
- As manager, restart an ordinary handover session in a new tab.
- As lead, when the architect waits on an `ask_user_question` dialog, tell the user that the
  architect's pane to the right of the lead holds the question. Never answer the dialog yourself and
  never type into the architect's pane.
- As lead, when the user gives you the answer instead, ask the user to close the dialog with one
  Escape press first.
- As lead, send that answer with `handover` `send` only after the architect's run ends, as
  `hc wait <terminal>` shows. A message sent while the dialog is open can arrive without starting
  the architect's turn.
- As lead, never stop the architect to deliver an answer.
- As lead, reopen the architect with `architect` `open` and the answer in its `request` only when no
  architect runs. `open` on a running architect returns its terminal and delivers nothing.
- As manager, when the user corrects you, fix the mistake, save it with `improvement` `record`, and
  propose a rule or check for the user to approve.
- As manager, do the work you can do instead of handing it back to the user. Make the tracker status
  change you can make, such as moving a slice to In Progress. Treat a proposal the user has
  effectively accepted as decided and do not ask again.

## Read the system's own source before reporting a gap

- Read the configuration or run record the system itself keeps before you report an integration or
  workflow as missing or disabled.
- Treat a filename scan or missing output as no evidence. The setting may live in another file, and
  a run with no output may be silent by design.
- Report `unknown` for a fact that only that source would settle, and name the source you could not
  read.

## Read each item's state before acting

- Before you act on or report a set of items, read each item's current state from the system that
  owns it: repository metadata for archived state, open PRs for finished work, and live terminals
  for running work.

## Report status in the user's terms

- Answer the feature the workspace exists for.
- Name each piece of work by what it does. Do not name a ticket by its identifier alone.

## Rule table

The prose above is authoritative. Rules without a check are owned by the human reviewer.

| Rule                                  | Enforced by                                                                                                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared workflow rules                 | [stomme](https://github.com/sQVe/stomme)                                                                                                                                            |
| Verify a tool's capability and effect | [tool schemas](../../tests/toolParameters.test.ts), [started-model readback](../piStart/piStart.test.ts), [detached output](../extensions/bashGuard/detachedOutputDecision.test.ts) |
