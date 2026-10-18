---
'tau': patch
---

A worker launch or follow-up now refuses with "Run /reload, then launch again" when Tau's skill tool
list changed on disk since the Pi session loaded it. Before, such a launch started a worker that
stopped with "Worker profile tools are not registered", such as for `mutation_check` after an
update.
