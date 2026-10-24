---
'tau': patch
---

An unpushed branch in a checkout with one Git remote now uses that remote when it has no push target
or remote-tracking ref. Pull request and stack resolution share the rule, so both work in a
single-remote checkout. Explicit and configured push targets still take precedence.
