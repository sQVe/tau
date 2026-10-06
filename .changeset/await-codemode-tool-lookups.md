---
'tau': patch
---

The codemode guidelines now say that `searchTools()`, `describeTool()`, and `describeNamespace()`
return promises, so scripts `await` them instead of failing with
`searchTools(...).map is not a function`.
