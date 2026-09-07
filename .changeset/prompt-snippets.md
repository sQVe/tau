---
'tau': minor
---

Add prompt snippets. Press `ctrl+shift+s` or run `/snippets` to pick single-purpose instructions
that are added before or after your next message. Toggles turn off after each send. Snippets are
skipped for a message that starts with a slash, because Pi expands skill and template commands only
at the start of the text. Snippet files are read from disk on every send, so edits apply without
reloading Pi.
