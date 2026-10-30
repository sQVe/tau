---
'tau': patch
---

The `code-review` skill now records each review's capture identity and the predecessor of a fix
review in its report, so a fix can name the review it follows. The `pr` skill selects a chain of
saved reviews, root first, and reads its coverage. With full coverage, it accepts the reviewed
content without a new full review. It still reads each link's report and judges each fix's scope
before it recommends a draft or ready status. A chain it cannot verify falls back to manual
assessment.
