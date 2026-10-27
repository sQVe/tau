---
'tau': patch
---

`pnpm smoke:pi` no longer writes to a Git repository selected by `GIT_DIR` or `GIT_INDEX_FILE` in
the caller's environment, and Pi gets the same Git environment.
