---
'tau': patch
---

The manager reviews a finished worker change with the `code-review` skill in fast mode, and reviews
fixes with its fix review, so each review is captured and the rounds form a chain the `pr` tool can
match. The pr skill assesses saved review evidence that cannot form a chain without asking, and asks
only when that assessment cannot establish coverage.
