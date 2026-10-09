---
'tau': patch
---

Bound codemode output to 4,000 tokens per script in the manager and in workers. A script that sets
`max_output_tokens` higher must give its reason on a second line, `// @budget: <reason>`, or it is
refused before it runs. Over the budget, Tau keeps whole `text()` items, names each cut item, and
saves the full output to a file, instead of Pi's cut that drops the middle without a name. The
codemode guidelines add rules for read batches, for not parsing `read` text as JSON, and for
launching independent workers together.
