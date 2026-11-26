---
'tau': patch
---

A focused `run_tests` run now selects a decision-table test by the name written in the table,
however long it is. Vitest renders an `it.each` `$name` through chai's display, which wraps the
value in quotes and cuts it short, so the exact name filter never matched the name Vitest
registered. The focused entry now removes that cut, and Tau accepts a requested name with or without
the display quotes.
