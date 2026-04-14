# tau

## 1.1.0

### Minor Changes

- [#1](https://github.com/sQVe/tau/pull/1)
  [`24c8e0a`](https://github.com/sQVe/tau/commit/24c8e0a6ae10bc7d8352ca45cfb34c85d7effa2b) Thanks
  [@sQVe](https://github.com/sQVe)! - Bootstrap the Tau repository baseline with project
  documentation, TypeScript and Vite+ tooling, quality gates, and automated workflows for CI,
  changesets, and releases.

- [#3](https://github.com/sQVe/tau/pull/3)
  [`81ee47c`](https://github.com/sQVe/tau/commit/81ee47c4f16bc6e558f24be081a802408d65a3ab) Thanks
  [@sQVe](https://github.com/sQVe)! - Add commit skill with typed tool, tree-sitter-bash guard, and
  TUI confirmation gate.

- [#2](https://github.com/sQVe/tau/pull/2)
  [`122a069`](https://github.com/sQVe/tau/commit/122a069d29674765e3643fa69f2e6623547a1773) Thanks
  [@sQVe](https://github.com/sQVe)! - Settle application structure under `src/`, tighten oxlint and
  oxfmt rulesets, add the ast-grep `types-before-runtime-code` rule, and scaffold the documentation
  system (ADRs 0001-0004, policy/guide/foundation templates, writing rules).

### Patch Changes

- [#4](https://github.com/sQVe/tau/pull/4)
  [`abf7b91`](https://github.com/sQVe/tau/commit/abf7b91dc7f3adab53adb92e3ece6af8ab8e1ae1) Thanks
  [@sQVe](https://github.com/sQVe)! - Fix the Changesets release flow so merging the release PR
  creates a tagged GitHub Release for the private package.

- [#5](https://github.com/sQVe/tau/pull/5)
  [`16ab38d`](https://github.com/sQVe/tau/commit/16ab38d1cc0d19cf92614af7e3f1057a1e9ac40b) Thanks
  [@sQVe](https://github.com/sQVe)! - Improve commit failure diagnostics by including trimmed hook
  output in `CommitFailedError` messages, and add coverage for the whitespace-only stderr fallback
  case.
