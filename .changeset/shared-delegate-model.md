---
'tau': minor
---

Bulk reads use their own model, independently of Pi's session model. Invalid settings and model
failures return errors without switching models.

Remove `TAU_BULK_READ_MODEL`. Set `bulkRead.model` in `~/.pi/agent/tau.json` instead.
