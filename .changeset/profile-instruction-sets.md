---
'tau': minor
---

Load only the instruction sets each worker profile names. A profile's `instruction-sets:` setting
lists them from `writing`, `coding`, and `workflow`; without it, a worker loads all three. The
bundled `scout` and `qa` profiles load `writing` and `workflow` and no longer receive the coding
instructions. A worker appends its sets from its saved task, so a follow-up keeps them.

Task records move to format 5, which saves the instruction sets. Follow-ups of older tasks get all
three sets.
