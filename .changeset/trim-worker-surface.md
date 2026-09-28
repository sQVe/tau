---
'tau': minor
---

Trim worker surface that carried no information. `subagent_reply` no longer takes `scopeUnchanged`,
and `subagent_follow_up` no longer takes `settingsUnchanged`. The `subagent` description drops its
state legend. Workers no longer save a `notified` event; saved tasks that still have one read as
before. A profile that sets `session-mode` or `permissions` now fails as an unsupported setting.

Workers now refuse `/new`, `/resume`, and `/fork`, so a worker stays in the session its task is
bound to.
