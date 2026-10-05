---
'tau': patch
---

`bulk_read` is removed, and stock `read` results are no longer trimmed. The bundled `scout`,
`reviewer`, and `worker` profiles get `codemode` and gather evidence with scripts. The `qa` and
`browser` profiles do not. A custom profile that still lists `bulk_read` fails at startup with the
missing-tool error.
