# ADR 0080: Insert prompt snippets as inline tokens

- Status: Accepted
- Date: 2026-10-01
- Supersedes: the toggling rules and the `placement` field in [ADR 0009](./0009-prompt-snippets.md),
  and [ADR 0013](./0013-snippet-placement.md)

## Context

- Turning on a snippet took a menu and many key presses for each message.
- Pi adds the editor text to history before Tau adds the snippet bodies. Recalling a prompt in the
  same session gave only the typed text, without the snippets.
- A resumed session fills history from the stored messages, which hold the full snippet bodies.
- Pi stores custom session entries from extensions and leaves them out of the model context.
- Each snippet had a `placement` that put its body before or after the whole message. A token typed
  in the middle of the text had no effect on where its body went.

## Options considered

- Keep the toggle menu and add faster keys. Rejected: the snippet choice still lives outside the
  text, so history loses it.
- Store the snippet choice on the user message. Rejected: Pi offers no field on a user message for
  extension data, and history reads only the text.
- Type each snippet as a `#token` in the message, with autocomplete. Chosen: the choice is part of
  the typed text, so history keeps it, and typing a few letters is faster than the menu.
- Keep `placement` and wrap the message with the bodies of its tokens. Rejected: the body lands far
  from where the user typed the token, so the sent message reads in a different order than the typed
  one.
- Replace each token with its snippet body where it stands. Chosen: the sent message reads in the
  order the user typed, and the user decides where each instruction goes.

## Decision

The user adds a snippet by typing `#` and its id in the message. The id is the snippet's filename
without `.md`. On send, Tau replaces each token with its snippet body where the token stands.
Snippets have no `placement` field.

### Tokens

- Only the id of a loaded snippet counts as a token. Other words, such as `#123` or a `# Heading`,
  stay plain text.
- Tokens follow the token boundary of Pi's editor, so autocomplete, the widget, and the send agree.
- Tokens in inline code and fenced code blocks stay plain text.
- A message that starts with a slash gets no snippets, and its tokens stay plain text, as ADR 0009
  decided for toggled snippets.
- A message with only tokens is valid.

### Expansion

- Each token becomes its snippet body as its own block, with one blank line between it and the text
  around it. At each join, Tau removes spaces and tabs on the token's line and blank lines, and
  drops empty text. A token at the start or end adds no blank lines, and a message with only tokens
  sends only the bodies.
- A content line that starts on a new line after a token keeps its indentation, so indented code
  after a token stays intact. Removing a repeated token follows the same rules.
- When a token appears more than once, the first one expands and the later ones are removed.
- A failure to read the snippets stops the send and keeps the typed text in the editor.
- A `placement` key left in a snippet file is ignored like any other unknown key. Tau reads snippets
  only from its own package, which no longer ships the key.

### Autocomplete and widget

- `#` opens a list of all snippets, and each letter after it narrows the list by name and
  description. A space after the query closes the list, so a heading such as `# Notes` leaves it
  closed.
- The widget lists the names of the snippets in the current editor text, in token order.

### History

- Each send that expands tokens saves a `snippet-history` custom session entry with a format
  version, a hash of the sent text, and the typed text.
- When Pi fills editor history with a sent text that matches a saved entry, Tau stores the typed
  text instead.
- Tau reads the entries on each session start. At startup and on tree navigation, Pi fills history
  after that into Tau's editor.
- After `/resume` or a fork, Pi fills history into its own editor before extensions start, and Tau's
  replacement editor does not copy it. `/reload` also replaces the editor without filling history.
  In these three cases Tau fills its editor from the session's user messages, in Pi's order, through
  the same swap. After `/new` the history stays empty.
- Sessions saved before this decision have no entries and keep showing the sent text.

## Tradeoffs

- Recalled prompts keep their tokens, in the same session and in a resumed or forked session.
- A snippet takes a few typed letters instead of a menu and several key presses.
- The sent message keeps the order the user typed, so each instruction sits next to the text it
  applies to.
- The `ctrl+q` shortcut and the `/snippets` command are gone, so no terminal key binding can hide
  snippets.
- Cost: the user must know or search for the id. A typo is sent as plain text without a warning.
- Cost: nothing groups instructions of the same kind. The user decides where each one goes.
- Cost: each expanded send adds a small entry to the session file.
- Cost: Tau copies Pi's token boundary because pi-tui does not export it. A change in Pi can make
  them differ.
- Cost: Tau repeats Pi's rule for which messages enter history after `/resume`, a fork, and
  `/reload`. A change in Pi can make the two histories differ.

## See also

- [ADR 0009: Prompt snippets](./0009-prompt-snippets.md)
- [ADR 0013: Snippet placement](./0013-snippet-placement.md)
- [ADR 0053: Version each saved record format](./0053-version-each-saved-record-format.md)
