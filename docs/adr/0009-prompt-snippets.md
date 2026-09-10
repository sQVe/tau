# ADR 0009: Prompt snippets

- Status: Accepted
- Date: 2026-09-09

## Context

- Some instructions apply to one message only, such as asking for a review instead of a change.
- Skills provide procedures. The model can load them, and users can invoke them with `/skill:name`.
  Snippets instead add short instructions to one message.
- Instructions added to the system prompt apply to every run and cannot be turned off for one
  message.
- Users need a way to write these short instructions themselves, without changing Tau's code.

## Options considered

- Use skills. Users can invoke them explicitly, but a procedure is more than a short instruction
  added to a message.
- Let users paste the text each time. Needs no code, but the wording drifts and long instructions
  are tiring to retype.
- Store the instructions as files and let the user toggle them per message. Keeps the wording stable
  and gives the user control over each send.

## Decision

Tau reads prompt snippets from markdown files and adds the active ones to the next message.

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

## Tradeoffs

- The user decides which instruction applies to which message.
- Snippet wording stays stable and is edited as ordinary markdown.
- Cost: snippets ship inside Tau, so a user's own snippet is a change to the repository.
- Cost: the menu requires the terminal UI. It is unavailable in RPC and print mode.

## See also

- [ADR-0001: Application structure](./0001-application-structure.md)
- [ADR-0007: Vim keys in interactive components](./0007-vim-keys-in-interactive-components.md)
- [ADR-0013: Snippet placement](./0013-snippet-placement.md)
