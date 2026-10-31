---
'tau': patch
---

`draft_review` collect no longer overwrites a draft that was replaced after collect read it. The
replaced file is reported as a conflict and keeps its new content. A herdr failure during collect
now names the review record directory, and the record stays so collect can run again.
