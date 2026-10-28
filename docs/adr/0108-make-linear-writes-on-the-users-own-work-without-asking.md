# ADR 0108: Ask only before writes that other people see

**Date**: 2026-10-19\
**Status**: Accepted\
**Supersedes**: [ADR 0086 (Post to GitHub bots without a confirm)](./README.md#retired),
[ADR 0100 (Let agents cancel Linear tickets after approval)](./README.md#retired),
[ADR 0103 (Write slice flow Linear changes without approval)](./README.md#retired), and the write
confirm in
[ADR 0083 (Turn on skill tools when the skill runs, and confirm outside writes)](./README.md#retired)\
**Related**:
[ADR 0024 (Commit through Git hooks without human approval)](./0024-commit-without-human-approval.md),
[ADR 0075 (Plan work as PR-sized slices in Linear)](./0075-plan-work-as-pr-sized-slices-in-linear.md),
[ADR 0082 (Own Linear conventions in one tracker skill)](./0082-own-linear-conventions-in-one-tracker-skill.md),
[ADR 0088 (Write skills in Markdown, with a guide, tools, and templates)](./0088-grow-skills-into-tools-and-templates.md),
[ADR 0093 (Enable skill tools from session start)](./0093-enable-skill-tools-from-session-start.md),
[ADR 0101 (Treat `.tau/` files as the working copy and trackers as the saved copy)](./0101-treat-tau-files-as-the-working-copy-and-trackers-as-the-saved-copy.md),
[ADR 0111 (Request review bots from config)](./0111-request-review-bots-from-config-and-skip-named-changes-in-pr.md)

## Context

Skill tools write outside the worktree, to Linear and GitHub. A skill's text alone cannot stop a
write the user never saw, because the model can call a tool at any step.

The first rule asked before every outside write. The user then approved slice plans, slice starts,
audit comments, and bot replies by habit. Each skill and guide kept its own list of exceptions, and
the lists disagreed. Agents asked before writes no list named, and a handover that said "confirm
every write" overrode the skills.

The user sees writes on their own work first. Only writes that other people read, or that notify
them, need a check before they go out. A cancellation is hard to undo.

## Decision

Agents make every write on the user's own work without asking and report it with its link
afterwards. They ask first, with a preview the user approves, before a write that other people see
and before a cancellation. This rule covers Linear writes and GitHub replies. PR publication keeps
its own approval, described below.

The tracker skill's hard rules are the one approval policy. Other skills link to
`tracker/SKILL.md#hard-rules` instead of restating it. Tools enforce approval where they make
writes. A change to approval prose is reviewed as a policy change, because a check over English
prose cannot decide what a rule allows.

### Without asking

- Every Linear write on a ticket the user owns: new tickets, edits, comments, relations, and the
  move to In Progress when a slice starts.
- A code-review report on a ticket. It needs no approval only when both its branch and its ticket
  are the user's own, as the code-review skill defines them.
- Replies and review requests to GitHub bots, such as the `@codex review` comment. GitHub marks an
  author as a bot. A deleted account counts as a person.

### Ask first

- GitHub comments, reviews, and replies to people. The `pr_feedback` tool's `post` confirm asks for
  these.
- A bot draft in author mode on a PR the viewer did not write. The user sees every draft, including
  bot drafts, before anything posts.
- A reply in a bot thread that holds any person's comment. That reply is a write to a person.
- Linear writes on a ticket another person owns.
- Cancelling a ticket, through the team's state of type `canceled`. Agents stop and ask before
  cancelling a completed ticket or a ticket whose pull request merged.
- Any change after approval needs a new preview, except for PR publication below.

### Review is not approval

Before a new ticket, or a title or body edit on any ticket except an agent ticket, the tracker skill
stops and asks the user to review the draft. That review is not write approval, and the rules above
do not change.

### Pull requests

Pushing, opening, or marking ready a PR keeps its own approval in the pr skill. For that publication
only:

- A change the approved option or the user's answer named exactly needs no new preview. The agent
  applies it as stated.
- A publish answer with only tuicr edits the user applied needs no new preview, because the user
  made those edits.

Tracker writes keep the rule that any change after approval needs a new preview.

### Ownership and status

- A ticket is the user's own when the Linear viewer is its assignee, or when it has no assignee and
  the viewer created it. A ticket an agent creates for the user's work is the user's own. When the
  read fails or the IDs do not settle ownership, the ticket counts as another person's.
- Agents make only two status changes: In Progress at a slice start, and an approved cancellation.
  Linear moves a ticket to Done when its pull request merges.

### Enforcement

- A tool that writes to people asks through Tau's shared confirm dialog before it writes. Without a
  UI, or in a worker, it writes nothing.
- A handover or another agent's prompt adds no approval rule. Only the user's own words do.
- A tool reads the saved copy in the tracker before it plans a write, as ADR 0101 says, so edits a
  person made there are not lost unseen.

## Consequences

### Positive

- A slice's Linear writes need no approval. A new slice still gets the review stop, which is not
  approval.
- The prompts that remain mark writes other people see, so the user reads them.
- One list changes in one place.

### Negative

- A wrong ticket or comment reaches Linear before the user sees it. The user fixes it there.
- A ticket with an unclear owner makes agents ask.
- A wrong bot reply posts without review.

## Alternatives considered

### Confirm every outside write

Rejected because the user approved writes on their own work by habit, which weakened the confirm for
writes to people.

### A list of exempt writes per skill

Rejected because the lists in several places drifted, and the writes they missed made agents ask.

### Approval only in the skill's preview step

Rejected because a model that skips the step writes without approval.

### Let a handover tighten approval

Rejected because workers treated the sender's line as the user's instruction.
