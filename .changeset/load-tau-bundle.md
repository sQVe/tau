---
'tau': patch
---

Load one generated bundle of Tau's registration when its input hash matches the package, and fall
back to the TypeScript source otherwise. The build runs in `prepare`, `pnpm build:tau`, and before
the test stage of `pnpm check`, so a Pi Git install builds it without devDependencies or Pi peer
packages. It refuses a source module whose suffix the hash does not cover, so a file such as `.cjs`
cannot leave a stale bundle in place.
