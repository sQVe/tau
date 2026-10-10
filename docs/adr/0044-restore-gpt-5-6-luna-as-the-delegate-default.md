# ADR 0044: Restore gpt-5.6-luna as the delegate default

**Date**: 2026-09-24\
**Status**: Superseded\
**Superseded by**:
[ADR 0072 (Keep model defaults out of code)](./0072-keep-model-defaults-out-of-code.md)\
**Supersedes**: [ADR 0041 (Default the delegate to gpt-6-luna)](./0041-default-the-delegate-to-gpt-6-luna.md)\
**Related**:
[ADR 0027 (Share one delegate model across bounded tool tasks)](./0027-share-one-delegate-model.md),
[Development](../development.md)

## Context

[ADR 0041](./0041-default-the-delegate-to-gpt-6-luna.md) changed the `TAU_DELEGATE_MODEL` default to
`openai-codex/gpt-6-luna` without a comparison. The owner states that gpt-6 is not benchmarking well
and is dropping it. No benchmark results are recorded here.

## Decision

Default `TAU_DELEGATE_MODEL` to `openai-codex/gpt-5.6-luna` when it is unset or empty. Restoring
`gpt-5.6-luna`, which [ADR 0027](./0027-share-one-delegate-model.md) chose after a labeled
comparison, returns the default to the last model with measured evidence. Bulk reads and web answers
use it unless the setting names another model. A web call's `answerModel` override still takes
precedence.

This replaces [ADR 0041](./0041-default-the-delegate-to-gpt-6-luna.md). Keep
[ADR 0027](./0027-share-one-delegate-model.md)'s other decisions.

## Consequences

### Positive

- The default returns to the model that [ADR 0027](./0027-share-one-delegate-model.md) measured.

### Negative

- The reason for dropping `gpt-6-luna` is the owner's statement, not a comparison recorded here.
- The delegate gives up the lower cost the owner claimed for `gpt-6-luna`.

## Alternatives considered

### Keep gpt-6-luna

Keep `gpt-6-luna`. Rejected because the owner no longer trusts its quality.
