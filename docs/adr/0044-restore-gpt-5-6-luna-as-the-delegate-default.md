# ADR 0044: Restore gpt-5.6-luna as the delegate default

- Status: Accepted
- Date: 2026-09-24
- Supersedes: [ADR 0041](./0041-default-the-delegate-to-gpt-6-luna.md)

## Context

[ADR 0041](./0041-default-the-delegate-to-gpt-6-luna.md) changed the `TAU_DELEGATE_MODEL` default to
`openai-codex/gpt-6-luna` without a comparison. The owner states that gpt-6 is not benchmarking well
and is dropping it. No benchmark results are recorded here.

## Options considered

- Keep `gpt-6-luna`. The owner no longer trusts its quality.
- Restore `gpt-5.6-luna`, which [ADR 0027](./0027-share-one-delegate-model.md) chose after a labeled
  comparison. Choose this option because it returns the default to the last model with measured
  evidence.

## Decision

Default `TAU_DELEGATE_MODEL` to `openai-codex/gpt-5.6-luna` when it is unset or empty. Bulk reads
and web answers use it unless the setting names another model. A web call's `answerModel` override
still takes precedence.

This replaces ADR 0041. Keep ADR 0027's other decisions.

## Tradeoffs

- The default returns to the model that ADR 0027 measured.
- Cost: the reason for dropping `gpt-6-luna` is the owner's statement, not a comparison recorded
  here.
- Cost: the delegate gives up the lower cost the owner claimed for `gpt-6-luna`.

## See also

- [ADR 0027: Share one delegate model across bounded tool tasks](./0027-share-one-delegate-model.md)
- [Development](../development.md)
