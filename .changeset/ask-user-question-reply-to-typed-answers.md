---
'tau': patch
---

After you type an answer in the `ask_user_question` dialog, the model must reply in visible text
before it asks again. If the typed text asks a question or asks for an explanation, the tool result
tells the model to answer it and end its turn. Tau refuses a new `ask_user_question` call until the
model has written visible text after the typed answer. Answers made only of chosen options work as
before.
