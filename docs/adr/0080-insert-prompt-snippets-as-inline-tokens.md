# ADR 0080: Insert prompt snippets as inline tokens

- Status: Accepted
- Date: 2026-10-01
- Supersedes: the toggling rules in [ADR 0009](./0009-prompt-snippets.md)

## Context

- Turning on a snippet took a menu and many key presses for each message.
- Pi adds the editor text to history before Tau adds the snippet bodies. Recalling a prompt in the
  same session gave only the typed text, without the snippets.
- A resumed session fills history from the stored messages, which hold the full snippet bodies.
- Pi stores custom session entries from extensions and leaves them out of the model context.

## Options considered

- Keep the toggle menu and add faster keys. Rejected: the snippet choice still lives outside the
  text, so history loses it.
- Store the snippet choice on the user message. Rejected: Pi offers no field on a user message for
  extension data, and history reads only the text.
- Type each snippet as a `#token` in the message, with autocomplete. Chosen: the choice is part of
  the typed text, so history keeps it, and typing a few letters is faster than the menu.

## Decision

The user adds a snippet by typing `#` and its id in the message. The id is the snippet's filename
without `.md`. Tau removes the tokens and wraps the rest of the message with the snippet bodies on
send.

### Tokens

- Only the id of a loaded snippet counts as a token. Other words, such as `#123` or a `# Heading`,
  stay plain text.
- Tokens follow the token boundary of Pi's editor, so autocomplete, the widget, and the send agree.
- Tokens in inline code and fenced code blocks stay plain text.
- A message that starts with a slash gets no snippets, and its tokens stay plain text, as ADR 0009
  decided for toggled snippets.
- A message with only tokens is valid.

### Autocomplete and widget

- `#` and at least one letter open a list of snippets matched by name and description. A bare `#`
  opens nothing, so headings stay quiet.
- The widget shows the snippets of the current editor text.

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
- The `ctrl+q` shortcut and the `/snippets` command are gone, so no terminal key binding can hide
  snippets.
- Cost: the user must know or search for the id. A typo is sent as plain text without a warning.
- Cost: each expanded send adds a small entry to the session file.
- Cost: Tau copies Pi's token boundary because pi-tui does not export it. A change in Pi can make
  them differ.
- Cost: Tau repeats Pi's rule for which messages enter history after `/resume`, a fork, and
  `/reload`. A change in Pi can make the two histories differ.

## See also

- [ADR 0009: Prompt snippets](./0009-prompt-snippets.md)
- [ADR 0013: Snippet placement](./0013-snippet-placement.md)
- [ADR 0053: Version each saved record format](./0053-version-each-saved-record-format.md)
