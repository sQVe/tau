---
'tau': patch
---

TDD test and production globs now match through minimatch. Each config compiles its glob rules once
instead of on every classified edit. A `?` in a glob now also matches one emoji or another character
outside the Basic Multilingual Plane.
