---
'tau': minor
---

Tau now provides `ask_user_question` itself instead of bundling
`@juicesharp/rpiv-ask-user-question`. In multi-select questions, Space checks an option and Enter
submits from any row, so the `Next` row is gone. Text typed in "Type something." is returned
together with the checked options instead of replacing them. Previews render below the option list.
Notes, the review tab, collapsing, the external editor, translations, and the RPC dialog fallback
are no longer available.
