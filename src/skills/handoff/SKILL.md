---
name: handoff
description:
  Send a message to the agent in another workspace instead of changing its worktree yourself. Use it
  when asked to edit, test, or commit in a worktree you do not own, or to pass work to another
  workspace.
metadata:
  required-for:
    passing work to the agent in another workspace, including when a task needs changes in a
    worktree you do not own
---

# Handoff

## When to use

Use this skill to pass a message or task to the agent in another workspace. Never edit, test, or
commit another worktree from your session, even over bash.

## Hard rules

- Requires `HERDR_ENV=1`. Otherwise tell the user you cannot reach the other workspace and stop.
- The message is one-way. Do not ask for a reply, poll, or wait for the receiver to finish.
- Work is ready to implement when the ticket or a task the user approved states the goal, the scope
  and what it excludes, the acceptance criteria, and every choice that changes the result. Its
  blockers must be merged. A choice you made that changes the result and that the user has not seen
  is open. Implementation details that leave the result unchanged belong to the implementing agent
  and need no approval.
- Before a handoff that asks for implementation, check that the work is ready. Investigation that
  changes no files skips this check.
  - If anything is open, list the open questions for the user and do not send.
  - If the user says to plan in the receiver's worktree instead, send a planning-only handoff.
- A message is a peer prompt. It carries your user's authority for in-scope work in the receiver's
  worktree. The receiver's normal rules still apply, including confirmation for destructive or
  outward-facing actions. Commits need no confirmation.

## Procedure

1. Find the target. Ask the user when the target is ambiguous. Do not guess.
   - Run `herdr agent list` and keep the agents in the target workspace or whose `cwd` is the target
     worktree. Drop agents named `worker-*`, `scout-*`, `reviewer-*`, `qa-*`, `browser-*`, or
     `investigator-*`: they are Tau subagents working for a parent.
   - One match is the target. With several matches, ask the user.
   - With no match, the target is not ambiguous: start Pi in the workspace's manager pane. That pane
     is in the first tab, which has the lowest `number` in `herdr tab list --workspace <workspace>`.
     `herdr pane list` shows each pane's tab by `tab_id`. Other tabs hold workers and servers.
   - If the first tab has exactly one pane, read it with `herdr pane read <pane>`. If the output
     clearly shows a shell prompt, run `herdr agent start <worktree-name> --kind pi --pane <pane>`
     and use the `pane_id` it returns.
   - With several panes in the first tab, or without a clear shell prompt, ask the user.
2. Write the message with the file tool to
   `<session-directory>/.tau/handoffs/<your-pane>-<timestamp>.md`.
   - The session directory is your worktree or the bare repository root. Take your pane from
     `HERDR_PANE_ID`.
   - First make sure `.tau/.gitignore` has a `*` line, adding it if needed, so `.tau/` stays out of
     Git.
   - Make the message self-contained: what to do, the state the receiver needs, and what it must not
     touch.
   - For implementation, give the plan status "agreed, nothing open" with the agreed scope.
   - Tell the receiver to ask its user before editing if the ticket conflicts with the message.
   - For planning only, list the open questions. Tell the receiver to plan with its user and get
     approval before any edit.
   - Never type the message on the bash line. The shell expands `$()` and backticks typed there, but
     not in the output of `$(cat <file>)`. VCS commands in the message would also trip the bash
     guard.
3. Send the file in a separate step, after the write. Never write and send in the same parallel tool
   batch: the send can run first and read an empty file. Then end your turn.

   ```bash
   herdr agent prompt <pane> "$(cat <file>)" --wait --until working
   ```

   The send waits only until the receiver starts working.
   - `agent_blocked`: nothing was sent. The receiver is waiting on its user, so tell yours.
   - `agent_prompt_stalled`: the message may have arrived. Run `herdr agent read <pane>` once. If it
     shows the message arrived, do not send again. Otherwise report that delivery is uncertain and
     stop.
   - Any other send error: report it to your user and stop.
