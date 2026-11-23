---
'tau': patch
---

A `tau.json` that is valid JSON but not an object, such as `[]` or `null`, fails every config read
with `Invalid Tau config <path>: not a JSON object (found <kind>).` instead of being read as an
empty config.
