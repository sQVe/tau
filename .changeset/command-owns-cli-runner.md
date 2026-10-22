---
'tau': patch
---

`src/command.ts` now owns the command runtime type, JSON parsing, and the output check that the
GitHub, Linear, and tuicr readers shared. `errorMessage` prints the JSON of an object without a
message.
