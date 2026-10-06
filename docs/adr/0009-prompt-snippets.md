# ADR 0009: Prompt snippets

**Date**: 2026-09-09\
**Status**: Accepted; toggling, the `placement` field, and reading snippets before each send
superseded by
[ADR 0080 (Insert prompt snippets through autocomplete)](./0080-insert-prompt-snippets-through-autocomplete.md),
and the `order` field by
[ADR 0081 (Sort prompt snippets by id)](./0081-sort-prompt-snippets-by-id.md)\
**Related**: [ADR 0001 (Application structure)](./0001-application-structure.md),
[ADR 0007 (Vim keys in interactive components)](./0007-vim-keys-in-interactive-components.md),
[ADR 0013 (Snippet placement)](./0013-snippet-placement.md),
[ADR 0080 (Insert prompt snippets through autocomplete)](./0080-insert-prompt-snippets-through-autocomplete.md),
[ADR 0081 (Sort prompt snippets by id)](./0081-sort-prompt-snippets-by-id.md)

## Context

Some instructions apply to one message only, such as asking for a review instead of a change.

Skills provide procedures. The model can load them, and users can invoke them with `/skill:name`.
Snippets instead add short instructions to one message. Instructions added to the system prompt
apply to every run and cannot be turned off for one message.

Users need a way to write these short instructions themselves, without changing Tau's code.

## Decision

Tau reads prompt snippets from markdown files and adds the active ones to the next message. Storing
the instructions as files and letting the user toggle them per message keeps the wording stable and
gives the user control over each send.

### Snippet files

Snippets live in `src/extensions/snippets/snippets/`, one markdown file each. Tau reads them when
the menu opens and before applying selected snippets, so edits take effect without `/reload`.

Each file starts with a frontmatter block. Every field is optional.

| Field         | Default                    | Meaning                                           |
| ------------- | -------------------------- | ------------------------------------------------- |
| `name`        | The filename without `.md` | Shown in the menu and the widget                  |
| `description` | Empty                      | Shown next to the name in the menu                |
| `placement`   | `append`                   | `prepend` puts the body before the user's text    |
| `order`       | `9999`                     | Sorts within the group; equal orders sort by name |

A file without a frontmatter block, or without body text, is skipped.

### Toggling

`ctrl+q` and `/snippets` both open the toggle menu. Tau registers both because a terminal or
multiplexer can take `ctrl+q` for itself.

Toggles turn off after snippets are applied to a message and when the user starts, switches, or
forks a session. Slash commands and failed snippet loading leave the toggles on for the next
ordinary message.

## Consequences

### Positive

- The user decides which instruction applies to which message.
- Snippet wording stays stable and is edited as ordinary markdown.

### Negative

- Snippets ship inside Tau, so a user's own snippet is a change to the repository.
- The menu requires the terminal UI. It is unavailable in RPC and print mode.

## Alternatives considered

### Skills

Use skills. Rejected because, although users can invoke them explicitly, a procedure is more than a
short instruction added to a message.

### Paste the text each time

Let users paste the text each time. Rejected because, although it needs no code, the wording drifts
and long instructions are tiring to retype.
