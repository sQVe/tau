# ADR 0152: Check for a hand-back before a lead turn settles

**Date**: 2026-11-25\
**Status**: Accepted\
**Related**: [ADR 0109 (Keep action behavior out of extension roots)](./0109-keep-action-behavior-out-of-extension-roots.md),
[ADR 0120 (Capability modules with an enforced import table)](./0120-capability-modules-with-an-enforced-import-table.md)

## Context

The lead ends turns by asking the user to approve or do a step that its finished work already
settled. The rule against it exists in the workflow instructions and the lead guidelines, but saved
corrections show the same shape repeated. Each turn ended in prose, so the question gate never saw
it.

A model or classifier judge would add latency, cost, and nondeterminism to every settle. The shapes
worth catching are narrow enough for text rules.

## Decision

A deterministic check runs before a lead turn settles, and one displayed reminder continues the turn
when the final text hands work back to the user. No model call.

A pure decision function takes the role, the final assistant text, the run outcome, and whether the
check already reminded since the last user message. It returns `remind` for a yes/no permission
question about the lead's next step, a question that waits for approval of a proposal before the
lead acts, or a request that the user does or confirms a step. It ignores fenced code blocks and
block quotes, because a permission phrase there is not a question to the user.

It returns `settle` for a choice between named alternatives, a plain report, a non-lead session, an
errored or aborted run, and a second hand-back since the last user message. A choice between named
alternatives is a real decision for the user, so the check must not turn it into a reminder.

The extension appends one custom message with `display: true` and asks Pi to continue the turn. The
check itself makes no model request; when it returns `remind`, the continuation adds one provider
request. The reminder runs before the turn settles, not before the assistant text is shown. A new
user message resets the one-reminder budget. The reminder names the two valid next steps: do the
settled step, or ask through `ask_user_question` when a real decision or outward approval is needed.

## Consequences

### Positive

- The check is deterministic and adds no model cost or latency.
- The lead gets one chance to finish a step before the turn settles.
- A choice question or a plain report still settles without a reminder.

### Negative

- Text rules can miss a hand-back phrased outside their patterns, and can remind on a false
  positive.
- The lead can ignore the reminder.
- Architect and worker sessions are not covered.

## Alternatives considered

### Keep only the prose rule

The workflow instructions and lead guidelines already forbid the hand-back. Rejected because saved
corrections show the rule alone did not change the behavior.

### A model or classifier judge

Ask a model to decide whether the final text hands work back. Rejected because it adds latency,
cost, and nondeterminism to every settle, while the shapes to catch are narrow.

### Remind on every question

Remind whenever the final text asks the user anything. Rejected because it would interrupt choice
questions and dialogs that genuinely need the user.
