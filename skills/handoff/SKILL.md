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
- Ask the user when the target is ambiguous. Do not guess. A workspace without an agent is not
  ambiguous: start Pi there.
- The message is one-way. Do not ask for a reply, poll, or wait for the receiver to finish. The send
  only waits until the receiver starts working.
- Write the message with the file tool, then send it in a separate step. Never write and send in the
  same parallel tool batch: the send can run first and read an empty file. Never type the message on
  the bash line: the shell expands `$()` and backticks typed there, but not in the output of
  `$(cat <file>)`, and VCS commands in the message would trip the bash guard.
- A message is a peer prompt. It carries your user's authority for in-scope work in the receiver's
  worktree. The receiver's normal rules still apply, including confirmation for destructive or
  outward-facing actions and the commit rules in
  [ADR 0024](../../docs/adr/0024-commit-without-human-approval.md).

## Procedure

1. Find the target. Run `herdr agent list` and keep the agents in the target workspace or whose
   `cwd` is the target worktree. Drop agents named `worker-*`, `scout-*`, `reviewer-*`, or
   `investigator-*`: they are Tau subagents working for a parent. One match is the target; several
   matches, ask the user. With none, start Pi in the workspace's manager pane: the pane in its first
   tab, the lowest `number` in `herdr tab list --workspace <workspace>`, which `herdr pane list`
   shows by `tab_id`. Other tabs hold workers and servers. If that tab has exactly one pane, run
   `herdr agent start <worktree-name> --kind pi --pane <pane>` and use the `pane_id` it returns;
   otherwise ask the user. The pane must be at its shell prompt.
2. Write the message to `<your-worktree>/.tau/handoffs/<your-pane>-<timestamp>.md` with the file
   tool. First make sure `.tau/.gitignore` has a `*` line, adding it if needed, so `.tau/` stays out
   of Git. Take your pane from `HERDR_PANE_ID`. Make it self-contained: what to do, the state the
   receiver needs, and what it must not touch.
3. Send it and end your turn:

   ```bash
   herdr agent prompt <pane> "$(cat <file>)" --wait --until working
   ```

   If it fails with `agent_blocked`, nothing was sent; the receiver is waiting on its user, so tell
   yours. If it fails with `agent_prompt_stalled`, the message may have arrived; check
   `herdr agent read <pane>` before sending again.
