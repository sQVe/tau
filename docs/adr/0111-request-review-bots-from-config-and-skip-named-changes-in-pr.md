# ADR 0111: Request review bots from config and skip the preview for a named change

**Date**: 2026-10-14\
**Status**: Accepted\
**Extends**: [ADR 0061 (Keep Tau config in a user file and a trusted repository file)](./0061-layer-tau-config-from-user-and-repository-files.md)\
**Related**:
[ADR 0086 (Post to GitHub bots without a confirm)](./0086-post-to-github-bots-without-a-confirm.md)

## Context

The `pr` skill posted one fixed `@codex review` comment on each new PR. Repositories use other
review bots, and an update after new commits got no request. The skill also asked for a new preview
after any change, even when the approved option had already named it, such as "Change something: add
a line saying X". The user then approved the same text twice.

## Decision

Read the review bots from the user config, as ADR 0061 defines the `reviews` key, and let `pr`
request them without asking. A repository with no entry gets no request, because Tau cannot know
which bots the user trusts.

A read-only `reviewBots` action of the `pr` tool gives each bot one status, from a pure decision
function: `reviewed` when the bot's login reviewed the current head, `requested` when a comment with
the request text came at or after the later of the head commit's committer date and the earliest
check suite of the head, and `request` otherwise. The skill posts each `request` and reads the
action again before any retry, so a retry never posts twice. The tool reads the head commit's
committer date and its check suites with `gh api`, since the commit list of `gh pr view` stops at
100 commits. `gh` does not report the push time. GitHub creates check suites when it receives a
push, so the earliest suite stands in for the push time. With no check suite, the committer date
alone applies.

A change after approval needs a new preview, unless the approved option or the user's answer named
that exact change and the skill applies it as stated.

## Consequences

### Positive

- Each repository chooses its bots, and updates ask a bot again after new commits.
- A retry or a second run never posts a request twice for one head.
- The user approves a named change once.

### Negative

- A user must write one entry per repository and bot.
- A repository with no check apps has no check suite. There, a request made after the commit but
  before the push, or after a rebase with an old committer date, can count for the new head, so no
  new request is posted.
- The skill decides whether a change was named exactly, so a loose reading skips a needed preview.

## Alternatives considered

### Keep the fixed Codex comment

Rejected because it ignores other bots and cannot skip a bot that already reviewed the head.

### Ask the user before each request

Rejected because ADR 0086 already lets skills post to bots without a confirm, and the question added
a prompt without a decision.
