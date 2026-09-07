# Prompt snippets

Prompt snippets are small, single-purpose instructions that Tau adds to your message when you send
it. A skill is loaded when the model needs a procedure. A snippet is chosen by you, for one message,
and applies to nothing else.

## Use the menu

Press `alt+s` or run `/snippets` to open the toggle menu.

| Key            | Action                                       |
| -------------- | -------------------------------------------- |
| `up` or `down` | Move the cursor, or scroll in the preview    |
| `space`        | Turn the selected snippet on or off          |
| `tab`          | Preview the selected snippet, and return     |
| `enter`        | Apply the toggles and close the menu         |
| `esc`          | Close the menu and keep the previous toggles |

The menu scrolls when the list is taller than the terminal and shows how many rows are hidden.

Active snippets appear in a widget above the editor. Prepended snippets are listed under
`↑ prepend`, appended snippets under `↓ append`.

## How a message is built

When you send a message, Tau joins the parts with blank lines in this order:

1. The bodies of the active prepend snippets, by `order`.
2. Your text.
3. The bodies of the active append snippets, by `order`.

Toggles turn off after each send and at the start of a session, so a snippet never applies to a
message you did not choose it for.

Snippets are skipped for a message that starts with a slash, such as `/skill:commit` or a prompt
template. Pi expands those only when the command is the first thing in the text, and wrapping the
text would send the command unexpanded. The toggles stay on, so they apply to your next ordinary
message.

## Add or edit a snippet

Snippets live in [`src/extensions/snippets/snippets/`](../src/extensions/snippets/snippets/), one
markdown file each. Tau reads the directory every time the menu opens and every time you send a
message, so an edit applies to your next message without `/reload`.

Write the body as an instruction to the agent, and follow the
[writing instructions](../src/extensions/writing/instructions.md).

```markdown
---
name: Concise
description: Keep answers short
placement: prepend
order: 10
---

Keep your response short. Skip the preamble.
```

Every field is optional:

| Field         | Default                    | Meaning                                           |
| ------------- | -------------------------- | ------------------------------------------------- |
| `name`        | The filename without `.md` | Shown in the menu and the widget                  |
| `description` | Empty                      | Shown next to the name in the menu                |
| `placement`   | `append`                   | `prepend` puts the body before your text          |
| `order`       | `9999`                     | Sorts within the group; equal orders sort by name |

A file without a frontmatter block, or without body text, is skipped. If the snippets directory or
one of its files cannot be read while you have snippets selected, Tau stops the send, reports the
error, and puts your text back in the editor. Your toggles stay on, so you can fix the files and
send again.
