# Preview

Use this shape for the Linear layout in the step 5 preview. Draw it as an ASCII tree with aligned
columns. Mark each ticket as `new`, `update`, or `unchanged`, and give each slice its `blocked-by`
numbers and rough size in changed lines. Under each slice, add one line on what it delivers and one
line from its `## Out of scope`.

```text
ENG-120  update  Add PR-sized planning
├─ 1     new     Record the lifecycle                   ~150
│                The decision record for the slice lifecycle.
│                Out of scope: the skill itself.
└─ 2     new     Add the slice skill    blocked-by 1    ~300
                 The /slice skill and its tests.
                 Out of scope: starting a slice.
```
