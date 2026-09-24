---
'tau': minor
---

Workers now ask their parent for delegation instead of launching workers themselves. Each parent
controller caps its live workers in memory, using `TAU_SUBAGENT_CAP` once at startup. Tau no longer
saves root-tree locks or capacity reservations. Earlier task records with nesting metadata are
skipped as retired. Task scans also skip unreadable or unsupported records with diagnostics, so one
checkout's records cannot hide unrelated work. Direct task reads still report errors.
