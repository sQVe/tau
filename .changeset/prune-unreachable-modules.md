---
'tau': minor
---

Remove the config, workspace state, and TDD runner modules, which no extension imported, along with
the `proper-lockfile` and `web-tree-sitter` dependencies and the vendored bash grammar.

Harden the commit tool's staging guarantee: sensitive-path patterns now match in subdirectories and
ignore case, paths are compared in repository-root space so the tool works from a subdirectory,
`--literal-pathspecs` stops an argument being read as a glob, and the staged set is verified both
after staging and after the commit, so a directory argument or a pre-commit hook cannot slip in
files nobody named.

Replace the tree-sitter commit guard with a single pattern that also catches environment prefixes,
wrappers, `commit-tree`, and shell-escaped spellings, while leaving paths under `commit/` alone.
