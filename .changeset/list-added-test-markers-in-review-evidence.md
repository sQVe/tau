---
'tau': minor
---

`code_review evidence` and `pr evidence` now return `markers`: added diff lines that hold `.skip(`,
`.only(`, `.todo(`, `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, or `oxlint-disable`.
Markdown files are skipped. Reviewers see where a test may have been weakened; nothing blocks.
Quoted Git file names that hold characters such as emoji now keep their exact name in review
captures.
