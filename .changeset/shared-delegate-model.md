---
'tau': minor
---

Use `TAU_DELEGATE_MODEL=provider/model-id` for bulk reads, web answers, and commit comment review,
independently of Pi's session model. The default remains `openai-codex/gpt-5.6-luna`; comment review
now uses it too. Web calls retain their `answerModel` override. Invalid settings and delegate
failures return errors without switching models or bypassing review.

Remove `TAU_BULK_READ_MODEL`. Set `TAU_DELEGATE_MODEL` instead.
