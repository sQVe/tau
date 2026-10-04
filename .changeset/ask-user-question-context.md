---
'tau': patch
---

`ask_user_question` questions now need a `context` of 1-3 sentences. It says what is being decided,
why now, and what the answer changes. The dialog shows it below the question. Option descriptions
are limited to 220 characters and stay visible for every option. Mark a recommended option with
`recommended: true`; the dialog shows a `★ Recommended` badge, and labels with "(Recommended)" are
rejected. If one option of a question has a preview, every option needs one. The preview has a title
and keeps its rows on short terminals. Ctrl+O shows a clipped preview in full, and Esc returns to
the options. The guidance asks for one question by default and for questions that make sense to a
user who has not read the discussion.
