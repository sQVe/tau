# ADR 0111: Request review bots from config

**Date**: 2026-10-14\
**Status**: Accepted\
**Related**: [ADR 0061 (Keep Tau config in a user file and a trusted repository file)](./0061-layer-tau-config-from-user-and-repository-files.md),
[ADR 0108 (Ask only before writes that other people see)](./0108-make-linear-writes-on-the-users-own-work-without-asking.md)

## Context

The `pr` skill posted one fixed `@codex review` comment on each new PR. Repositories use other
review bots, and an update after new commits got no request.

## Decision

Read the review bots from the user config, as ADR 0061 defines the `reviews` key, and let `pr`
request them without asking. A repository with no entry gets no request, because Tau cannot know
which bots the user trusts.

A read-only `reviewBots` action of the `pr` tool gives each bot one status, from a pure decision
function: `reviewed` when the bot's login reviewed the current head, `requested` when a comment with
the request text came at or after the later of the head commit's committer date and the earliest
check suite of the head, and `request` otherwise. The skill posts each `request` and reads the
action again before any retry, so a retry does not post twice for one head. A head whose committer
date is later than the request still shows `request`, and the skill posts again. The tool reads the
head commit's committer date and its check suites with `gh api`, since the commit list of
`gh pr view` stops at 100 commits. `gh` does not report the push time. GitHub creates check suites
when it receives a push, so the earliest suite stands in for the push time. With no check suite, the
committer date alone applies.

## Consequences

### Positive

- Each repository chooses its bots, and updates ask a bot again after new commits.
- A retry or a second run does not post a request twice for one head, unless the head's committer
  date is later than the request.

### Negative

- A user must write one entry per repository and bot.
- A repository with no check apps has no check suite. There, a request made after the commit but
  before the push, or after a rebase with an old committer date, can count for the new head, so no
  new request is posted.

## Alternatives considered

### Keep the fixed Codex comment

Rejected because it ignores other bots and cannot skip a bot that already reviewed the head.

### Ask the user before each request

Rejected because ADR 0108 already lets skills post review requests to bots without asking, and the
question added a prompt without a decision.
