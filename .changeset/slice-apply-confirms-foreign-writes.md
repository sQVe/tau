---
'tau': patch
---

`slice` `apply` asks you to confirm before it writes to a container or slice that another person
owns or whose owner is unknown. It lists the tickets and each write. When you decline, when no user
can answer, or in a worker, it writes nothing and returns `status: declined`. Creating tickets and
changing your own tickets still apply without a prompt.
