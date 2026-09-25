---
'tau': patch
---

Let `run_tests` accept existing test files whose paths contain brackets, such as Next.js routes like
`app/[teamId]/page.test.tsx`. Globs are still refused. The tool description now says up front that
it runs Vitest only.
