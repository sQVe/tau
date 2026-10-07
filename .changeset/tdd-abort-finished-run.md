---
'tau': patch
---

A finished `run_tests` run no longer reacts when its abort signal fires later. Before, it sent
`SIGKILL` to the run's old process group.
