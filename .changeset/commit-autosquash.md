---
'tau': minor
---

The `commit` tool now accepts a `fixup` field with a target commit and kind `fixup`, `squash`, or
`amend`. It checks all targets before staging and builds messages for autosquash rebases. The commit
skill and bash guard describe this path for fixing older commits.
