---
'tau': minor
---

Remove the config, workspace state, and TDD runner modules, which no extension imported, along with
the `proper-lockfile` and `web-tree-sitter` dependencies and the vendored bash grammar.

Strengthen the commit tool's staging checks. Sensitive-path patterns now match in subdirectories and
ignore case. Compare paths relative to the repository root so the tool works from a subdirectory.
Use `--literal-pathspecs` to prevent arguments from being read as globs. Check the staged set after
staging and after the commit. This prevents directory arguments or pre-commit hooks from including
files nobody named.

Replace the tree-sitter commit guard with a single pattern that also catches environment prefixes,
wrappers, `commit-tree`, and shell-escaped spellings, while leaving paths under `commit/` alone.
