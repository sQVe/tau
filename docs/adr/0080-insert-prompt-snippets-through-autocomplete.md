# ADR 0080: Store prompt snippets as files and insert them through autocomplete

**Date**: 2026-10-01\
**Status**: Accepted\
**Supersedes**: [ADR 0009 (Prompt snippets)](./README.md#retired),
[ADR 0013 (Snippet placement)](./README.md#retired),
[ADR 0081 (Sort prompt snippets by id)](./README.md#retired)

## Context

Some instructions apply to one message only, such as asking for a review instead of a change. The
system prompt applies to every run, and the user cannot turn off one of its instructions for a
single message. A skill is a procedure that the model loads, which is more than a short instruction.

Turning on a snippet took a menu and many key presses for each message.

Pi adds the editor text to history before extensions change the sent text. A snippet that Tau adds
on send is missing when the user recalls the prompt. A resumed session fills history from the stored
messages, so any difference between the typed and the sent text shows up again after `/resume`, a
fork, or `/reload`.

Each snippet had a `placement` that put its body before or after the whole message, far from where
the user chose it.

The autocomplete list shows only a snippet's id, name, and description, so the user cannot see what
a pick inserts. pi-tui's editor does not expose the selected autocomplete item. It reports only
whether the list is open.

## Decision

Tau stores each prompt snippet as a markdown file. The user types `#` and picks a snippet from the
autocomplete list. Tau replaces the `#query` with the snippet body. Tau does not change the text on
send. Snippets have no `placement` or `order` field. The editor then shows exactly what Pi sends, so
Pi's own history is correct without any hidden state.

### Snippet files

- Snippets live in `src/extensions/snippets/snippets/`, one markdown file each. The file name
  without `.md` is the snippet id, which the user types after `#`.
- A file starts with a frontmatter block. Every field is optional, and an empty value counts as
  absent:

| Field         | Default        | Meaning                           |
| ------------- | -------------- | --------------------------------- |
| `name`        | The snippet id | Shown in the list and the preview |
| `description` | Empty          | Shown after the name in the list  |

- The body is the text after the block. Tau trims whitespace at its start and end, and it turns CRLF
  line endings into LF.
- A file without a frontmatter block, or without body text, is skipped.
- Snippets sort by id. A bare `#` lists them in that order, and matches with equal scores keep that
  order.

### Autocomplete

- `#` opens a list of all snippets. Each letter after it narrows the list by id, name, and
  description. A space after the query closes the list, so a heading such as `# Notes` opens none.
  Text that is not a snippet query goes to Pi's own autocomplete, and so does Tab after a finished
  query.
- The list follows the token boundary of Pi's editor and stays closed inside inline code and fenced
  code blocks.
- Tau reads the snippets once at session start. A read failure shows a warning, and the list stays
  empty.

### Preview

- While the list is open and a snippet is selected, a widget above the editor shows the snippet
  body. It follows the selection and the list as the user types. It clears when the list closes,
  after a pick, and when the selected item is not a snippet. The widget is a component that wraps
  the whole body, because Pi cuts a widget given as lines after ten lines.
- Tau wraps the editor and reads the selected item from pi-tui's private `autocompleteList` field
  after each render. Until Pi ships a public API for it, Tau keeps this workaround. Suggestions
  arrive after a debounce and an async lookup, so no key press marks when the list changes, but
  pi-tui renders the editor after each change. Tau sets the widget only when the previewed snippet
  changes.
- Tau builds its editor from the previous editor factory, or from Pi's `CustomEditor` when there is
  none.

### Insertion

- The body replaces the query and keeps its own line breaks and indentation.
- Text before the query on its line stays above the body, with one blank line between them. Text
  after the cursor on that line moves below the body, after one blank line.
- The cursor ends after the body.

## Consequences

### Positive

- What the editor shows is what Pi sends and what history recalls, also after `/resume`, a fork, or
  `/reload`.
- The user decides which instruction applies to each message. The user can edit the snippet text for
  one message before sending it.
- The user sees the snippet text before picking it.
- Snippet wording stays stable and is edited as ordinary markdown.
- A new snippet needs no number, and the list order follows the id that the user types.
- Tau keeps no session entries or send handler for snippets.
- The `ctrl+q` shortcut and the `/snippets` command are gone, so no terminal key binding can hide
  snippets.

### Negative

- Long snippet text fills the preview, the editor, and each history entry.
- Snippets ship inside Tau, so a user's own snippet is a change to the repository.
- Snippets load only in the terminal UI, so RPC and print mode have no list.
- A hand-typed `#id` stays plain text. Only a pick from the list inserts a snippet.
- The author cannot put the most used snippets first.
- A snippet edited on disk applies only after the next session start or `/reload`.
- Tau copies Pi's token boundary because pi-tui does not export it. A change in Pi can make them
  differ.
- The preview reads a private pi-tui field. If Pi renames it, the preview stays empty, and a test
  against the real editor fails.
- Pi does not copy history into a replacement editor. After `/resume`, a fork, or `/reload`, Tau
  refills it from the user messages in Pi's order. A change in how Pi fills history can make them
  differ.

## Alternatives considered

### Toggle menu with faster keys

Keep the toggle menu and add faster keys. Rejected because the snippet choice still lives outside
the text, so history loses it.

### `#token` replaced on send

Type each snippet as a `#token` and replace the token with the body on send. Rejected because
history needs saved session entries and a wrapped editor to show the typed tokens, and Tau must
refill history after `/resume`, a fork, and `/reload` by copying Pi's rules. The editor also does
not show what the model receives.

### Preview updated on each key press

Update the preview after each key press. Rejected because suggestions arrive later, so the preview
misses the first list and each list that changes while the user types.

### Skills

Use skills. Rejected because, although users can invoke them explicitly, a procedure is more than a
short instruction added to a message.

### Paste the text each time

Let users paste the text each time. Rejected because, although it needs no code, the wording drifts
and long instructions are tiring to retype.

### Keep the `order` field

Keep the `order` field. Rejected because, although it lets the author put common snippets first, the
user types letters to find a snippet, and every new snippet needs a number.

### Sort by name

Sort snippets by name. Rejected because the user types the id, so the list would not match what they
type.
