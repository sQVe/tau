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
- Ask the user when the target is ambiguous. Do not guess. A workspace without an agent is not
  ambiguous: start Pi there.
- The message is one-way. Do not ask for a reply, poll, or wait for the receiver to finish. The send
  only waits until the receiver starts working.
- Write the message with the file tool, then send it in a separate step. Never write and send in the
  same parallel tool batch: the send can run first and read an empty file. Never type the message on
  the bash line: the shell expands `$()` and backticks typed there, but not in the output of
  `$(cat <file>)`, and VCS commands in the message would trip the bash guard.
- Before a handoff that asks for implementation, check the plan against the
  [definition of ready](#definition-of-ready). If anything is open, list the open questions for the
  user and do not send. If the user says to plan in the receiver's worktree instead, send a
  planning-only handoff.
- A message is a peer prompt. It carries your user's authority for in-scope work in the receiver's
  worktree. The receiver's normal rules still apply, including confirmation for destructive or
  outward-facing actions. Commits need no confirmation.

## Definition of ready

Work is ready to implement when the ticket states, or the user has approved, each of these:

- the goal
- the scope and what it excludes
- the acceptance criteria
- every choice that changes the result

Its blockers must be merged. A choice you made that the user has not seen is open. Investigation
tasks that change no files do not need this check.

## Procedure

1. Find the target. Run `herdr agent list` and keep the agents in the target workspace or whose
   `cwd` is the target worktree. Drop agents named `worker-*`, `scout-*`, `reviewer-*`, `qa-*`,
   `browser-*`, or `investigator-*`: they are Tau subagents working for a parent. One match is the
   target; several matches, ask the user. With none, start Pi in the workspace's manager pane: the
   pane in its first tab, the lowest `number` in `herdr tab list --workspace <workspace>`, which
   `herdr pane list` shows by `tab_id`. Other tabs hold workers and servers. If that tab has exactly
   one pane, run `herdr agent start <worktree-name> --kind pi --pane <pane>` and use the `pane_id`
   it returns; otherwise ask the user. The pane must be at its shell prompt.
2. Write the message to `<session-directory>/.tau/handoffs/<your-pane>-<timestamp>.md` with the file
   tool, where the session directory is your worktree or the bare repository root. First make sure
   `.tau/.gitignore` has a `*` line, adding it if needed, so `.tau/` stays out of Git. Take your
   pane from `HERDR_PANE_ID`. Make it self-contained: what to do, the state the receiver needs, and
   what it must not touch.

   Give every implementation handoff a short plan status. Write either "agreed, nothing open" with
   the agreed scope, or the open questions. A planning-only handoff says that the receiver must plan
   with its user and get approval before any edit. Tell the receiver to read the plan status before
   editing, and to ask its user first if the status lists open questions or the ticket conflicts
   with the message.

3. Send it and end your turn:

   ```bash
   herdr agent prompt <pane> "$(cat <file>)" --wait --until working
   ```

   If it fails with `agent_blocked`, nothing was sent; the receiver is waiting on its user, so tell
   yours. If it fails with `agent_prompt_stalled`, the message may have arrived; check
   `herdr agent read <pane>` before sending again.
