# ADR 0013: Snippet placement

- Status: Accepted
- Date: 2026-09-10

## Context

- [ADR 0009](./0009-prompt-snippets.md) gave snippets a `placement` field and a default, but said
  nothing about how to choose a value.
- Each snippet author picked a placement by feel. Two snippets with the same kind of instruction
  ended up on opposite sides of the user's message.
- Nothing recorded what placement does and does not do, so authors could read it as a way to make an
  instruction stronger.

## Options considered

- Leave the choice to the author. Needs no rule, but the set keeps drifting as snippets are added.
- Sort by snippet age or by the order the author wants the model to work in. Easy to apply, but the
  model does not run the instructions in order, so the grouping tells the reader nothing.
- Choose by the snippet's main purpose. Puts instructions of the same kind together and gives a new
  author a rule to follow.

## Decision

Choose placement by the snippet's main purpose.

- **Prepend** sets how to approach the work: gather context, clarify the request, question
  assumptions, or verify claims.
- **Append** sets the action boundary or the expected output: investigate without changes, draft
  without posting, or produce a specific kind of response.

When a snippet serves both purposes, use its main purpose. If neither is primary, split the snippet.

Placement groups instructions of the same kind so the message reads as one request. It does not
enforce execution order and does not give an instruction extra authority. State safety boundaries in
the snippet text, whatever the placement.

## Tradeoffs

- A new snippet has a rule to follow instead of a judgment call.
- Related instructions sit together, so the assembled message reads in one voice.
- Cost: a snippet that fits both groups needs the author to name a main purpose, and reasonable
  authors can disagree.
- Cost: the rule is prose. Nothing in the code rejects a snippet placed against it.

## See also

- [ADR-0009: Prompt snippets](./0009-prompt-snippets.md)
- [ADR-0010: Documentation scope](./0010-documentation-scope.md)
