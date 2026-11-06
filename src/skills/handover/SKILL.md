---
name: handover
description:
  Send a message to the agent in another workspace instead of changing its worktree yourself. Use it
  when asked to edit, test, or commit in a worktree you do not own, or to pass work to another
  workspace.
metadata:
  required-for:
    passing work to the agent in another workspace, including when a task needs changes in a
    worktree you do not own
---

# Handover

## When to use

Use this skill to pass a message or task to the agent in another workspace. Never edit, test, or
commit another worktree from your session, even over bash.

## Hard rules

- Requires `HC_TERMINAL_ID`. Otherwise tell the user you cannot reach the other agent and stop.
- The message is one-way. Do not ask for a reply, poll, or wait for the receiver to finish.
- When receiving a handover, report to your own user and send nothing back unless the message asks
  for a reply.
- Send a requested reply only through the `handover` tool's `send` action, never with `hc send` in
  bash.
- A handover links to records, such as tickets or `.tau/` working copies, and is not a record
  itself.
- Work is ready to implement when the ticket or a task the user approved states the goal, the scope
  and what it excludes, the acceptance criteria, and every choice that changes the result. Its
  blockers must be merged. A choice you made that changes the result and that the user has not seen
  is open. Implementation details that leave the result unchanged belong to the implementing agent
  and need no approval.
- Before a handover that asks for implementation, check that the work is ready. Investigation that
  changes no files skips this check.
  - If anything is open, list the open questions for the user and do not send.
  - If the user says to plan in the receiver's worktree instead, send a planning-only handover.
- A message is a peer prompt. It carries your user's authority for in-scope work in the receiver's
  worktree. The receiver's own skills decide which actions need approval. A handover tightens them
  only when it quotes the user. Do not add approval rules of your own. Commits need no confirmation.

## Procedure

1. Find the target. Ask the user when the target is ambiguous. Do not guess.
   - Run `hc ls --json`. Keep the terminals whose `cwd` is the target worktree or inside it, whose
     `status.app` is `pi`, and that have no `parent`. Children with a `parent` are Tau workers.
   - When a row lacks `cwd`, `parent`, or an object `status`, run `hc get <t> --json` on that
     terminal before you decide. Those fields are optional in `hc` output.
   - One match is the target. With several matches, ask the user.
   - With no match, the target is not ambiguous: start Pi in the checkout's space. Step 3 shows how.
2. Call the `handover` tool's `prepare` action in your worktree or the bare repository root. Write
   the message with the file tool to `<directory>/<your HC_TERMINAL_ID>-<timestamp>.md`, using the
   returned `directory`. Save no file until the tool has prepared the directory.
   - Make the message self-contained: what to do, the state the receiver needs, and what it must not
     touch.
   - For implementation, give the plan status "agreed, nothing open" with the agreed scope.
   - Tell the receiver to ask its user before editing if the ticket conflicts with the message.
   - For planning only, list the open questions. Tell the receiver to plan with its user and get
     approval before any edit.
   - Never type the message on the bash line. The shell expands `$()` and backticks typed there. VCS
     commands in the message would also trip the bash guard.
3. Send the file in a separate step, after the write. Never write and send in the same parallel tool
   batch: the send can run first and read an empty file. Then end your turn.
   - With a target, call the `handover` tool with action `send`, the target's address as `terminal`,
     and the message path as `file`. Then read its status:
     - `started`: the receiver began its turn. End your turn.
     - `notStarted`: the text arrived but no turn started. Do not send again. Tell your user.
     - `blocked`: nothing was sent, and the receiver waits on its user. Tell your user.
     - Any other error: report it to your user and stop.
   - Never force a send or wait for the receiver's turn.
   - With no target, find the space for the checkout by its folder in `herdr-app ls`, never by its
     name. Then call the `handover` tool with action `start`, the checkout as `folder`, and the
     message path as `file`:
     - One space for the checkout: pass its ID as `space`.
     - Several spaces for the checkout: ask the user which one.
     - No space: leave `space` out and pass `name` as a short title of what the work does, such as
       `completion uses the read record`: about 40 characters, lowercase, one line, and no ticket
       ID.
   - Never rename a reused space. The user may have renamed it by hand.
   - Then end your turn.
