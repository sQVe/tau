---
'tau': patch
---

A repository selects its TDD runner with `tdd.runner`. A config layer that changes the runner starts
from that runner's built-in defaults, so another runner's globs do not carry over. An unknown runner
name fails config loading and names the known runners. With no `runner` set, the loaded config and
behavior stay the same, and the selected runner validates `verificationArgv`.
