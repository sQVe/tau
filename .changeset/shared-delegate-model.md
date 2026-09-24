---
'tau': minor
---

Use `TAU_DELEGATE_MODEL=provider/model-id` for bulk reads and web answers, independently of Pi's
session model. The default remains `openai-codex/gpt-5.6-luna`. Web calls retain their `answerModel`
override. Invalid settings and delegate failures return errors without switching models.

Remove `TAU_BULK_READ_MODEL`. Set `TAU_DELEGATE_MODEL` instead.
