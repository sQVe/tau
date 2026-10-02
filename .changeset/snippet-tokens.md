---
'tau': minor
---

Add prompt snippets by typing `#` and the snippet name in your message, such as `#push-back`. Type a
few letters after `#` to pick a snippet from a list matched by name and description, then press Tab
or Enter. The widget above the editor shows the snippets in the current text. On send, Tau replaces
each token with its snippet text where you typed it, so the message keeps your order. Unknown words
such as `#123`, headings, and tokens inside code stay plain text. Recalling a prompt from history
now shows the tokens you typed instead of the full snippet text, also when Pi starts on a saved
session. The `ctrl+q` shortcut, the `/snippets` command, and the snippet menu are removed.
