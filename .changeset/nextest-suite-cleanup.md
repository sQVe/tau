---
'tau': patch
---

Test suites register their temporary-directory and environment cleanup through one suite cleanup
helper. Vitest ignored cleanup registered inside `beforeAll`, so nextest target and basic-crate
folders accumulated in `/tmp`. A lint rule now rejects `afterAll` registered inside another hook.
