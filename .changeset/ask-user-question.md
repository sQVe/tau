---
'tau': minor
---

Bundle the `@juicesharp/rpiv-ask-user-question` package so Pi loads its `ask_user_question` tool
with Tau. Tau checks at session start that the tool is registered and fails with a clear error when
it is missing.
