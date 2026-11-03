---
'tau': patch
---

`draft_review` collect no longer overwrites a draft that was replaced or grew after collect read it.
The changed file is reported as a conflict and keeps its new content. An `hc` failure during collect
now names the review record directory, and the record stays so collect can run again.
