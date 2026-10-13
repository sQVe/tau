---
'tau': minor
---

The `ask_user_question` dialog now shows a line for each worker that reports, asks, or stops while
it is open. While a notice waits, a "Handle the notice from <worker> first" row below the options
closes the dialog with a deferred result. That result is not an answer and approves nothing. The
manager handles the notice, then asks the same questions again, and the dialog restores your
selections and typed text. Esc still declines.
