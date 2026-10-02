# ADR 0081: Sort prompt snippets by id

- Status: Accepted
- Date: 2026-10-02
- Supersedes: the `order` field in [ADR 0009](./0009-prompt-snippets.md)

## Context

- Snippets had an `order` field that sorted the toggle menu.
- Since [ADR 0080](./0080-insert-prompt-snippets-through-autocomplete.md), the user picks a snippet
  by typing its id after `#`. The fuzzy filter ranks the matches.
- The order still sets the list after a bare `#`, and the order of matches with equal scores.
- Each new snippet needed a number that fit among the others.

## Options considered

- Keep `order`. Rejected: it lets the author put common snippets first, but the user types letters
  to find a snippet, and every new snippet needs a number.
- Sort by name. Rejected: the user types the id, so the list would not match what they type.
- Drop `order` and sort by id. Chosen: the list follows what the user types, and the files need no
  numbers.

## Decision

Snippets have no `order` field. Tau sorts them by id, the filename without `.md`.

## Tradeoffs

- The list after a bare `#` is alphabetical, so the user can predict where a snippet is.
- A new snippet needs no number.
- Cost: the author cannot put the most used snippets first.

## See also

- [ADR 0009: Prompt snippets](./0009-prompt-snippets.md)
- [ADR 0080: Insert prompt snippets through autocomplete](./0080-insert-prompt-snippets-through-autocomplete.md)
