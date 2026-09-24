# ADR 0041: Default the delegate to gpt-6-luna

- Status: Accepted
- Date: 2026-09-24

## Context

[ADR 0027](./0027-share-one-delegate-model.md) set `openai-codex/gpt-5.6-luna` as the default for
`TAU_DELEGATE_MODEL`. It chose that model after a labeled comparison and asked for the comparison to
be repeated before the default changes. Pi's registry now has `openai-codex/gpt-6-luna`. The owner
states that it is the next Luna iteration and costs less.

## Options considered

- Keep `gpt-5.6-luna` until a repeated comparison passes ADR 0027's review gate. This keeps measured
  evidence behind the default but keeps the older model.
- Run the comparison first, then switch. The owner declined the extra work for a successor model in
  the same family.
- Switch to `gpt-6-luna` without a comparison. Choose this option because the owner accepts the
  quality risk in exchange for the newer, cheaper model.

## Decision

Default `TAU_DELEGATE_MODEL` to `openai-codex/gpt-6-luna` when it is unset or empty. Bulk reads, web
answers, and commit comment review use it unless the setting names another model. A web call's
`answerModel` override still takes precedence.

This replaces the default and the repeat-the-comparison rule in ADR 0027. Keep its other decisions.
No comparison was run for this change.

## Tradeoffs

- The delegate follows the current Luna model at a lower cost.
- Cost: no labeled comparison shows that `gpt-6-luna` meets ADR 0027's review gate. A weaker model
  could miss inaccurate comments or block commits falsely.
- Cost: the cost claim is the owner's statement, not a measurement recorded here.

## See also

- [ADR 0027: Share one delegate model across bounded tool tasks](./0027-share-one-delegate-model.md)
- [Development](../development.md)
