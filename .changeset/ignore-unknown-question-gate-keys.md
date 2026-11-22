---
'tau': patch
---

`questionGate` accepts unknown keys at any depth and warns once per session with the file and the
full key path, as other config blocks do. A wrong type or a missing required field still fails the
block with the same message.
