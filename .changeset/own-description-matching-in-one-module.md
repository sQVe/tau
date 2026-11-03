---
'tau': patch
---

Move the rule that decides whether a saved description matches a Linear description into its own
module, `src/extensions/slice/descriptionMatch.ts`. `slice` and `start_slice` use it as before.
Behavior is unchanged.
