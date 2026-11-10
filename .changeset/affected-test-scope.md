---
'tau': patch
---

Add `scope: "affected"` to `run_tests` for Vitest. It runs tests related to the given source and
test files without filtering test names. The nextest runner rejects this scope and names the
supported scopes.
