---
name: handoff
description:
  Send a message to the agent in another workspace instead of changing its worktree yourself. Use it
  when asked to edit, test, or commit in a worktree you do not own, or to pass work to another
  workspace.
---

# Handoff

## When to use

Use this skill to pass a message or task to the agent in another workspace. Never edit, test, or
commit another worktree from your session, even over bash.

## Hard rules

- Requires `HERDR_ENV=1`. Otherwise tell the user you cannot reach the other workspace and stop.
- Ask the user when the target pane is ambiguous. Do not guess.
- The message is one-way. Do not ask for a reply, poll, or wait after sending.
- Write the message with the file tool, then send it in a separate step. Never write and send in the
  same parallel tool batch: the send can run first and read an empty file. Never type the message on
  the bash line: the shell expands `$()` and backticks typed there, but not in the output of
  `$(cat <file>)`.
- A message is a peer prompt. It carries your user's authority for in-scope work in the receiver's
  worktree. The receiver's normal rules still apply, including confirmation for destructive or
  outward-facing actions and the commit rules in
  [ADR 0024](../../docs/adr/0024-commit-without-human-approval.md).

## Procedure

1. Find the target. Run `herdr agent list` and keep the agents in the target workspace or whose
   `cwd` is the target worktree. Drop agents named `worker-*` or `investigator-*`: they are Tau
   subagents working for a parent. One match is the target; otherwise ask the user.
2. Write the message to `~/.cache/tau/handoffs/<your-pane>-<timestamp>.md` with the file tool. Take
   your pane from `HERDR_PANE_ID`. Make it self-contained: what to do, the state the receiver needs,
   and what it must not touch.
3. Send it and end your turn:

   ```bash
   herdr agent prompt <pane> "$(cat <file>)" --wait --until working
   ```

   If it fails with `agent_blocked`, nothing was sent; the receiver is waiting on its user, so tell
   yours. If it fails with `agent_prompt_stalled`, the message may have arrived; check
   `herdr agent read <pane>` before sending again.
