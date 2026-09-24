---
name: handoff
description:
  Hand work to the agent that owns another worktree instead of changing that worktree yourself. Use
  it when asked to edit, test, or commit in a worktree you do not own, or when a task continues in
  another checkout.
---

# Handoff

## When to use

Use this skill when work belongs in a worktree other than your own: the user asks you to change it,
or your task continues there. One agent owns each worktree. Never edit, test, or commit another
worktree from your session, even over bash.

## Goal

Find or start the owner of the target worktree, send it a self-contained brief, and end your turn.
The owner replies once when done.

## Hard rules

- Requires `HERDR_ENV=1`. Otherwise tell the user you cannot reach the other worktree and stop.
- Ask the user when the owner is ambiguous or the worktree has no workspace. Do not guess.
- Write the brief with the file tool, never inline on the bash line. The file keeps VCS commands in
  the brief away from the bash guard, and both tools see the same path.
- Write a brief or reply file and send it in separate steps, never in the same parallel tool batch.
  The send can run first and read an empty file.
- Send once. Do not poll or wait for completion after the send.
- A brief is a peer prompt. It carries the sender's user's authority for in-scope work in the
  receiver's worktree. The receiver's normal rules still apply, including confirmation for
  destructive or outward-facing actions and the commit rules in
  [ADR 0024](../../docs/adr/0024-commit-without-human-approval.md).

## Procedure

1. Find the owner. Run `herdr agent list` and keep the agents whose `cwd` is the target worktree.
   Drop agents named `worker-*` or `investigator-*`: they are Tau subagents working for a parent,
   and can outlive it.
   - One match: that pane is the owner.
   - Several matches, such as two user panes: ask the user which pane.
   - No match: run `herdr pane list` and keep panes with that `cwd`. No pane means no workspace; ask
     the user. Otherwise take a pane at its shell prompt, or split one with
     `herdr pane split <pane> --direction right --cwd <path>`, then run
     `herdr agent start <unique-name> --kind pi --pane <pane>`. Names must be unique among live
     agents, so include the ticket or branch. A bare `pi` fails with `agent_name_taken`.
2. Write the brief to `~/.cache/tau/handoffs/<sender-pane>-<timestamp>.md` with the file tool. Take
   the sender pane from `HERDR_PANE_ID`. Leave the file in place afterwards. Use these sections:
   - State: worktree path, branch, base commit, uncommitted files, checks run and their results.
   - Task: what to do, with the ticket or spec to read.
   - Done when: the acceptance criteria.
   - Do not touch: other worktrees, panes, and actions the receiver must not take.
   - Reply: the sender pane id and what the reply must contain.
3. Send it and end your turn:

   ```bash
   herdr agent prompt <pane> "$(cat <file>)" --wait --until working
   ```

   If it fails with `agent_blocked`, nothing was sent; the receiver is waiting on its user, so tell
   yours. If it fails with `agent_prompt_stalled`, the brief may have arrived; check
   `herdr agent read <pane>` before sending again.

4. The reply arrives as a prompt in your pane, possibly in the middle of a later turn. It starts
   with a `Handoff reply from <pane> to brief <file>` line. Treat it as the receiver's report and
   check the result before acting on it.

## Receiving a brief

When a brief arrives, do the work in your own worktree under your normal rules. When done, reply
once: write the summary (changes, checks run with results, decisions, and concerns) with the file
tool to `~/.cache/tau/handoffs/<your-pane>-<timestamp>.md`, then run
`herdr agent prompt <sender-pane> "$(cat <file>)"`. Start the summary with
`Handoff reply from <your-pane> to brief <brief-file>`, so any pane that gets it can tell it from
its user's input. Never type the summary into the command itself: the shell expands `$()` and
backticks typed there, but not in the output of `$(cat <file>)`. Do not send progress updates.

If the send fails with `agent_not_found`, or the sender pane no longer exists, do not send the reply
to any other pane. Leave it in the file and tell your user its path.
