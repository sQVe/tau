---
'tau': patch
---

An architect session launches and resumes workers. The skill-tools launch check now skips a listed
tool that the session's role never registers, such as the `architect` tool outside the lead role. A
lead session that lacks a listed tool still gets the `/reload` refusal. An architect session can
launch only investigation workers.
