---
'tau': patch
---

Fix `run_tests` reporting input freshness as `unknown` on every run in Pi. Input hashing used a
`glob` option that the Bun runtime in Pi rejects. Results now report `fresh` or `stale` again. When
hashing fails, the result keeps the reason in `inputs.error`.
