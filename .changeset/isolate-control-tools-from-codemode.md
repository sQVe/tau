---
'tau': patch
---

Codemode scripts can no longer see or call the worker controls `subagent_report`,
`subagent_question`, and `subagent_progress`, the questionnaire `ask_user_question`, or the
orchestration tools `subagent`, `subagent_follow_up`, `subagent_reply`, and `subagent_cancel`. The
model still calls them directly. Scripts can still call `subagent_status`.
