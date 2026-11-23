---
'tau': patch
---

Add a code-quality rule that a finding which removes or moves a test must map each claim to a
surviving assertion before it says coverage stays, and a caller-owned claim needs an assertion
through the same caller.
