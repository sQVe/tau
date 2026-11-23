---
'tau': patch
---

A `tau.json` that is valid JSON but not an object, such as `[]` or `null`, now fails every config
read with `Invalid Tau config <path>: not a JSON object (found <kind>).` Before, some readers
reported a misleading error about the field they were reading.
