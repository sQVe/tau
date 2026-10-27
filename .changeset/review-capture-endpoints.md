---
'tau': patch
---

A complete range or working tree review capture now records its endpoint: the Git tree a commit of
the reviewed content would have, and the tree it started from. The capture checks that the change
between the two trees is the change its saved patch shows, and keeps both trees with a ref under
`refs/tau/review-captures/`. Other captures record why they have no complete endpoint. A read of a
capture whose endpoint trees are gone reports it as missing, and one whose trees no longer match the
saved patch reports it as altered.
