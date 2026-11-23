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
- When a received handover leaves a question only its sender can answer, ask the sender with
  `handover_question` before you ask your user. Reasons include a decision only the sender can make,
  a missing input, a ticket that conflicts with the message, and "this spec or test looks wrong".
  When the ticket conflicts with the message, stop before editing: ask the sender first and edit
  after the answer. This question is the one exception to the one-way and send-nothing-back rules;
  ordinary replies still follow them. Without that tool, or when it refuses, ask your user with
  `ask_user_question`.
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
   - For a ticket that conflicts with the message, point to the sender-first rule in Hard rules: the
     receiver asks you and edits after your answer, and asks its user only when that tool is
     unavailable or refuses.
   - For planning only, list the open questions. Tell the receiver to plan with its user and get
     approval before any edit.
   - Never type the message on the bash line. The shell expands `$()` and backticks typed there. VCS
     commands in the message would also trip the bash guard.
3. Send the file in a separate step, after the write. Never write and send in the same parallel tool
   batch: the send can run first and read an empty file. Then end your turn.
   - With a target, call the `handover` tool with action `send`, the target's address as `terminal`,
     and the message path as `file`. Then read the result:
     - `queued`: the receiver saved the message. End your turn. Do not send it again, even with no
       sign that the receiver read it.
     - `unknown`: the receiver may have saved it. Report the result to your user and stop. Retry
       only when your user asks.
     - A refusal: nothing was queued. Tell your user why. You may offer `handover start` as an
       option, but do not start a receiver unless your user asks.
     - Any other error: report it to your user and stop.
   - Never wait for the receiver's turn.
   - With no target, call the `handover` tool with action `start`, the checkout as `folder`, the
     message path as `file`, and `name` as a short title of what the work does, such as
     `completion uses the read record`: about 40 characters, lowercase, one line, and no ticket ID.
     The tab is named `lead: <name>`. Start with `name` and no `space`.
     - A refusal that names a space: the checkout already has one. Pass the named space as `space`
       to reuse it. When the refusal names several, ask the user which one.
     - Pass `newSpace: true` only when the user asks for another space.
     - Pass `model` when the receiver must run a model other than the default, such as a DeepSeek
       lead.
   - Never rename a reused space. The user may have renamed it by hand.
   - Then end your turn.
