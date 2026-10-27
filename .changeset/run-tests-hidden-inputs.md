---
'tau': patch
---

TDD now counts dot files and dot folders that match your TDD globs as inputs. Before, an edit to a
hidden file such as `.hidden.ts` in `src` after a passing run did not mark the results stale.
Default excluded folders, such as `.git`, are still skipped.
