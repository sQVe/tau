# ADR 0041: Default the delegate to gpt-6-luna

**Date**: 2026-09-24\
**Status**: Superseded\
**Superseded by**:
[ADR 0044 (Restore gpt-5.6-luna as the delegate default)](./0044-restore-gpt-5-6-luna-as-the-delegate-default.md);
comment review removed from the delegate by
[ADR 0042 (Remove commit comment review)](./0042-remove-commit-comment-review.md)\
**Related**: [ADR 0027 (Share one delegate model across bounded tool tasks)](./0027-share-one-delegate-model.md),
[Development](../development.md)

## Context

[ADR 0027](./0027-share-one-delegate-model.md) set `openai-codex/gpt-5.6-luna` as the default for
`TAU_DELEGATE_MODEL`. It chose that model after a labeled comparison and asked for the comparison to
be repeated before the default changes. Pi's registry now has `openai-codex/gpt-6-luna`. The owner
states that it is the next Luna iteration and costs less.

## Decision

Default `TAU_DELEGATE_MODEL` to `openai-codex/gpt-6-luna` when it is unset or empty. Switching to
`gpt-6-luna` without a comparison means the owner accepts the quality risk in exchange for the
newer, cheaper model. Bulk reads, web answers, and commit comment review use it unless the setting
names another model. A web call's `answerModel` override still takes precedence.

This replaces the default and the repeat-the-comparison rule in
[ADR 0027](./0027-share-one-delegate-model.md). Keep its other decisions. No comparison was run for
this change.

## Consequences

### Positive

- The delegate follows the current Luna model at a lower cost.

### Negative

- No labeled comparison shows that `gpt-6-luna` meets
  [ADR 0027](./0027-share-one-delegate-model.md)'s review gate. A weaker model could miss inaccurate
  comments or block commits falsely.
- The cost claim is the owner's statement, not a measurement recorded here.

## Alternatives considered

### Keep gpt-5.6-luna until a comparison passes

Keep `gpt-5.6-luna` until a repeated comparison passes
[ADR 0027](./0027-share-one-delegate-model.md)'s review gate. Rejected because, although this keeps
measured evidence behind the default, it keeps the older model.

### Compare first, then switch

Run the comparison first, then switch. Rejected because the owner declined the extra work for a
successor model in the same family.
