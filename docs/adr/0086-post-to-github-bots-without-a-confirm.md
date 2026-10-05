# ADR 0086: Post to GitHub bots without a confirm

- Status: Accepted
- Date: 2026-10-04

## Context

- A skill tool asks the user with `ctx.ui.confirm` before any write outside the worktree.
- On a pull request, most review threads come from review bots. A round often replies to and
  resolves many of them.
- A reply to a bot answers no person. People who follow the pull request can read it, but nobody
  waits on it. A confirm for each round of bot replies adds a prompt that the user approves without
  reading.

## Options considered

- Confirm every GitHub write. Rejected: the user approves bot replies by habit, and the habit
  weakens the confirm for writes to people.
- Post to bots without a confirm, and confirm writes to people. Chosen: the confirm appears only
  when the write answers a person.

## Decision

A skill tool posts to a GitHub bot without `ctx.ui.confirm`. It confirms any write that goes to a
person.

- An author is a bot only when GitHub marks it as one. A deleted account counts as a person.
- A thread with any comment from a person goes to a person.
- When one call writes to bots and to people, the tool asks once and shows the writes to people.
- A call with a write to a person needs a UI. Without one, it posts nothing.

## Tradeoffs

- Rounds with only bot threads post without a prompt.
- The confirm shows up only for writes that answer a person.
- Cost: a wrong or noisy reply to a bot posts without review.
- Cost: the tool must tell bots from people, and a wrong answer skips the confirm for a person.

## See also

- [ADR 0083: Turn on skill tools when the skill runs, and confirm outside writes](./0083-turn-on-skill-tools-when-the-skill-runs-and-confirm-outside-writes.md)
