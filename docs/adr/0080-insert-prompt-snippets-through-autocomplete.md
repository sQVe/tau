# ADR 0080: Insert prompt snippets through autocomplete

- Status: Accepted
- Date: 2026-10-01
- Supersedes: the toggling rules, the `placement` field, and the reading of snippets before each
  send in [ADR 0009](./0009-prompt-snippets.md), and [ADR 0013](./0013-snippet-placement.md)

## Context

- Turning on a snippet took a menu and many key presses for each message.
- Pi adds the editor text to history before extensions change the sent text. A snippet that Tau adds
  on send is missing when the user recalls the prompt.
- A resumed session fills history from the stored messages, so any difference between the typed and
  the sent text shows up again after `/resume`, a fork, or `/reload`.
- Each snippet had a `placement` that put its body before or after the whole message, far from where
  the user chose it.

## Options considered

- Keep the toggle menu and add faster keys. Rejected: the snippet choice still lives outside the
  text, so history loses it.
- Type each snippet as a `#token` and replace the token with the body on send. Rejected: history
  needs saved session entries and a wrapped editor to show the typed tokens, and Tau must refill
  history after `/resume`, a fork, and `/reload` by copying Pi's rules. The editor also does not
  show what the model receives.
- Pick a snippet from autocomplete after `#` and put its body in the editor. Chosen: the editor
  shows exactly what Pi sends, so Pi's own history is correct without any hidden state.

## Decision

The user types `#` and picks a snippet from the autocomplete list. Tau replaces the `#query` with
the snippet body. Tau does not change the text on send. Snippets have no `placement` field.

### Autocomplete

- `#` opens a list of all snippets, and each letter after it narrows the list by id, name, and
  description. A space after the query closes the list, so a heading such as `# Notes` leaves it
  closed. Other queries and Tab go to Pi's own autocomplete.
- The list follows the token boundary of Pi's editor and stays closed inside inline code and fenced
  code blocks.
- Tau reads the snippets once at session start. A read failure shows a warning, and the list stays
  empty.

### Insertion

- The body replaces the query and keeps its own line breaks and indentation.
- Text before the query on its line stays above the body, with one blank line between them. Text
  after the cursor on that line moves below the body, after one blank line.
- The cursor ends after the body.

## Tradeoffs

- What the editor shows is what Pi sends and what history recalls, also after `/resume`, a fork, or
  `/reload`.
- The user can edit the snippet text for one message before sending it.
- Tau keeps no session entries, editor wrapper, widget, or send handler for snippets.
- The `ctrl+q` shortcut and the `/snippets` command are gone, so no terminal key binding can hide
  snippets.
- Cost: long snippet text fills the editor and each history entry.
- Cost: a hand-typed `#id` stays plain text. Only a pick from the list inserts a snippet.
- Cost: a snippet edited on disk applies only after the next session start or `/reload`.
- Cost: Tau copies Pi's token boundary because pi-tui does not export it. A change in Pi can make
  them differ.

## See also

- [ADR 0009: Prompt snippets](./0009-prompt-snippets.md)
- [ADR 0013: Snippet placement](./0013-snippet-placement.md)
