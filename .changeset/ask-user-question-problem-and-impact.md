---
'tau': minor
---

`ask_user_question` questions now need a `problem` and an `impact` instead of a `context`. The
problem says what is going on, and the impact says what the answer changes or blocks. The dialog
shows them below the question and drops the impact first on short terminals. A question can set a
`preview` that every option shows, and an option's own preview replaces it while that option is
focused. The recommended option no longer has to come first: options keep a stable order, and the
dialog opens on the recommended one. The `pr` skill asks the publish question with the same four
options in the same order every time.
