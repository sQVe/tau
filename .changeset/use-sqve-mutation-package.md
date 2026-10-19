---
'tau': patch
---

When `.pi/tau.json` has no valid `mutation.argv`, the `mutation_check` error now gives
`["pnpm", "exec", "mutation"]` as its example. That is the command of the shared
[`@sqve/mutation`](https://www.npmjs.com/package/@sqve/mutation) package, which replaces copying
Tau's mutation script into each repository.
