---
'tau': patch
---

No behavior change. The test suite runs its Git calls through one shared helper in
`tests/gitRepository.ts`, and fakes Git on `PATH` through one shared command shim in
`tests/commandShimFake.ts`.
