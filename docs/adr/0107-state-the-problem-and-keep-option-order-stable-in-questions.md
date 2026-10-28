# ADR 0107: Put user decisions first with stated problems and stable options

**Date**: 2026-10-14\
**Status**: Accepted\
**Supersedes**: [ADR 0065 (Put user decisions first in replies)](./README.md#retired)\
**Related**: [ADR 0006 (Load Tau's instruction sets into every prompt)](./0006-default-writing-policy.md)

## Context

Long replies put the first user decision near the end, below long status reports. Options did not
say what was at stake, decisions referred to earlier turns, and several decisions were bundled into
one sentence. Some turns ended without the question.

Users often cannot decide from an `ask_user_question` dialog alone. In Pi sessions, some answers
were typed or the dialog was closed, and many typed answers asked what the issue was instead of
choosing. The single `context` field named the decision and its effect, but rarely the problem
behind it. Longer contexts did not change that.

The tool also required the recommended option to come first, because the dialog opened on the first
option. Options therefore changed order when the recommendation changed, so the same question looked
different from session to session. A preview belonged to one option, so a draft shown on the first
option disappeared when the user moved to another.

## Decision

A reply that needs a user decision starts with one sentence of status, then the decisions, then the
report and evidence. Each question states its problem and its impact in two required fields. Options
keep a natural, stable order, with the recommendation marked wherever it sits.

### Reply rules

- Each decision has a number, one question, and one sentence on what it changes or blocks. It must
  read without earlier messages.
- Options use letters, and each option says in one line what happens. `ask_user_question` uses
  labels and `recommended: true` instead of letters.
- A yes or no question states the default the agent uses without an answer.
- A skill's own reply or question format takes precedence over these rules, so skills such as
  code-review and pr keep their reports and `ask_user_question` prompts.
- A turn that waits for the user states the question. This rule sits in the workflow instructions
  because it governs when the agent stops, following [ADR 0006](./0006-default-writing-policy.md).
  The other rules sit in the writing instructions.

### Question fields

- `problem` says what is going on, in plain words. `impact` says what the answer changes or blocks.
- The tool rejects a blank field, a `problem` that repeats the question, and a `problem` equal to
  `impact`, each with its own message.
- A question-level `preview` shows for every option. An option's own preview replaces it while that
  option is focused.

### Option order

- The dialog opens on the recommended option, or on the first option when none is recommended.
- The tool accepts a recommendation in any position. Replies with lettered options follow the same
  rule: a natural, stable order with the recommendation marked.

## Consequences

### Positive

- The user sees what to decide without reading the report first.
- The user sees why a decision exists before the options.
- Each decision can be answered by number and letter.
- A repeated question, such as a PR approval, keeps the same labels in the same order.
- Content that every option acts on, such as a PR title and body, stays visible on every option.

### Negative

- Every call needs two fields instead of one, so questions get longer.
- The report comes after the decisions, so a user who wants the evidence first must scroll.
- Short replies with one decision carry more structure than they need.
- On a short terminal, options above the recommended one can scroll out of view when the dialog
  opens.
- The tool cannot check that the problem is explained well, only that it is present and distinct.

## Alternatives considered

### Require an explanation in the chat before the call

Refuse the call when the assistant message has no explanation before it. Rejected because the dialog
must stand alone for a user who returns cold, and a check on free chat text is unreliable.

### Keep the recommendation first

Keep reordering options so the dialog opens on the recommendation. Rejected because the order then
changes with the recommendation, and opening the dialog on the recommended option gives the same
focus without moving options.

### End with the decision

Keep the rule to end with the decision. Rejected because long replies keep hiding decisions below
the report.

### `ask_user_question` for every decision

Require `ask_user_question` for every decision. Rejected because the dialog has a problem, an
impact, and options, but no field for the status or the report. A reply that needs the evidence
first keeps its decisions in the chat.
