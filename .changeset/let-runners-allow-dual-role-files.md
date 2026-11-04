---
'tau': patch
---

TDD file roles are now two separate facts: a file can be a test file, a production file, or both.
Each runner decides whether a file that matches both glob lists is allowed to hold both roles.
Vitest keeps its current rule, so a Vitest test file is never also a production file. This prepares
Tau for a Rust runner whose unit tests live in `src/`.
