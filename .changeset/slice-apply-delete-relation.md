---
'tau': patch
---

`slice` `apply` no longer stops when a plan removes a blocked-by relation. It passes `--yes` to
`linear issue relation delete`, which otherwise asks for confirmation and fails.
