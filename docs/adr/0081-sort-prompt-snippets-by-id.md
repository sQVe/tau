# ADR 0081: Sort prompt snippets by id

**Date**: 2026-10-02\
**Status**: Accepted\
**Supersedes**: the `order` field in [ADR 0009 (Prompt snippets)](./0009-prompt-snippets.md)\
**Related**: [ADR 0009 (Prompt snippets)](./0009-prompt-snippets.md),
[ADR 0080 (Insert prompt snippets through autocomplete)](./0080-insert-prompt-snippets-through-autocomplete.md)

## Context

Snippets had an `order` field that sorted the toggle menu. Each new snippet needed a number that fit
among the others.

Since [ADR 0080](./0080-insert-prompt-snippets-through-autocomplete.md), the user picks a snippet by
typing its id after `#`. The fuzzy filter ranks the matches. The order still sets the list after a
bare `#`, and the order of matches with equal scores.

## Decision

Snippets have no `order` field. Tau sorts them by id, the filename without `.md`. The list then
follows what the user types, and the files need no numbers.

## Consequences

### Positive

- The list after a bare `#` is alphabetical, so the user can predict where a snippet is.
- A new snippet needs no number.

### Negative

- The author cannot put the most used snippets first.

## Alternatives considered

### Keep `order`

Keep the `order` field. Rejected because, although it lets the author put common snippets first, the
user types letters to find a snippet, and every new snippet needs a number.

### Sort by name

Sort snippets by name. Rejected because the user types the id, so the list would not match what they
type.
