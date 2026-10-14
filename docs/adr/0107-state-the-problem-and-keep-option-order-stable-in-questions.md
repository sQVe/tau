# ADR 0107: State the problem and keep option order stable in questions

**Date**: 2026-10-14\
**Status**: Accepted\
**Supersedes**: [ADR 0065 (Put user decisions first in replies)](./0065-put-user-decisions-first-in-replies.md),
its option order rule only

## Context

Users often cannot decide from an `ask_user_question` dialog alone. In Pi sessions since September,
about one in seven answers was typed or the dialog was closed, and many typed answers asked what the
issue was instead of choosing. The single `context` field named the decision and its effect, but
rarely the problem behind it. Longer contexts did not lower that share.

The tool also required the recommended option to come first, because the dialog opened on the first
option. Options therefore changed order when the recommendation changed, so the same question looked
different from session to session. A preview belonged to one option, so a draft shown on the first
option disappeared when the user moved to another.

## Decision

Each question states its problem and its impact in two required fields, and options keep a natural,
stable order with the recommendation marked wherever it sits.

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

- The user sees why a decision exists before the options.
- A repeated question, such as a PR approval, keeps the same labels in the same order.
- Content that every option acts on, such as a PR title and body, stays visible on every option.

### Negative

- Every call needs two fields instead of one, so questions get longer.
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
