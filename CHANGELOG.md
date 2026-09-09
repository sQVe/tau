# tau

## 2.0.0

### Major Changes

- [#20](https://github.com/sQVe/tau/pull/20) [`7cf58d2`](https://github.com/sQVe/tau/commit/7cf58d2f88448a64c3fd1a358e96c053d65db0d9) Thanks [@sQVe](https://github.com/sQVe)! - Require Pi 0.85.1 or later within the 0.85 series from `@earendil-works/pi-coding-agent`. Update
  comment review to use the session's model registry and migrate schemas to TypeBox 1.x.

### Minor Changes

- [#18](https://github.com/sQVe/tau/pull/18) [`f07a357`](https://github.com/sQVe/tau/commit/f07a3576220750c0046620ccea2b8b2e7d6bb62d) Thanks [@sQVe](https://github.com/sQVe)! - Bundle the `@juicesharp/rpiv-ask-user-question` package so Pi loads its `ask_user_question` tool
  with Tau. Tau checks at session start that the tool is registered and reports an extension error
  when it is missing.

- [#15](https://github.com/sQVe/tau/pull/15) [`0e843e4`](https://github.com/sQVe/tau/commit/0e843e49e73621e261556bd921c50a24df88519a) Thanks [@sQVe](https://github.com/sQVe)! - Load plain-language writing instructions into every ordinary Pi agent run. Keep the instructions
  beside the writing extension and report an error if they are missing or blank.

- [#1](https://github.com/sQVe/tau/pull/1) [`24c8e0a`](https://github.com/sQVe/tau/commit/24c8e0a6ae10bc7d8352ca45cfb34c85d7effa2b) Thanks [@sQVe](https://github.com/sQVe)! - Bootstrap the Tau repository baseline with project documentation, TypeScript and Vite+ tooling,
  quality gates, and automated workflows for CI, changesets, and releases.

- [#17](https://github.com/sQVe/tau/pull/17) [`ed1b1c8`](https://github.com/sQVe/tau/commit/ed1b1c8eacd270e8a9d1a5d75b2638d945f907ea) Thanks [@sQVe](https://github.com/sQVe)! - Add the bro skill. It restates the previous message in plain language: what happened, what it means,
  and what to do next, without re-running the work or changing the reported outcome.

- [#29](https://github.com/sQVe/tau/pull/29) [`644fdd7`](https://github.com/sQVe/tau/commit/644fdd7018146341e554d9217bbbe7f37fb156bc) Thanks [@sQVe](https://github.com/sQVe)! - Require a language tag on every code block in the writing instructions.

- [#28](https://github.com/sQVe/tau/pull/28) [`4f0f242`](https://github.com/sQVe/tau/commit/4f0f2427f40682dfcab6311bd64a7fcf3d3bf881) Thanks [@sQVe](https://github.com/sQVe)! - Add coding instructions to every ordinary agent run. They ask for code that breathes, with blank
  lines between the logical steps inside a function, and they take over the rules about which comments
  to keep from the writing instructions, so one file governs text and the other governs code.

- [#14](https://github.com/sQVe/tau/pull/14) [`e895c12`](https://github.com/sQVe/tau/commit/e895c12e27e22d070b6be930078c2d7b80d79246) Thanks [@sQVe](https://github.com/sQVe)! - Review staged comments before commit approval using the session model. Return blocking findings for
  up to two automatic correction attempts, keep missing-comment suggestions advisory, and require an
  explicit user waiver for unresolved findings or failed reviews. Recheck changed content, including
  changes made by commit hooks.

- [#22](https://github.com/sQVe/tau/pull/22) [`456c93c`](https://github.com/sQVe/tau/commit/456c93c73b13dfede49bda046e94e4e8c294556a) Thanks [@sQVe](https://github.com/sQVe)! - Take every logical commit group in one `commit` tool call, stepping through each group's review and
  overlay in turn, with `A` to approve all remaining.

- [#11](https://github.com/sQVe/tau/pull/11) [`16ae186`](https://github.com/sQVe/tau/commit/16ae186407a7ec9b075f12f93d325c4cd6654db7) Thanks [@sQVe](https://github.com/sQVe)! - Replace the commit tool's yes/no confirm dialog with an overlay that shows subject, body, and
  per-file diff stats, with approve, edit subject, edit body, skip, and abort choices.

- [#3](https://github.com/sQVe/tau/pull/3) [`81ee47c`](https://github.com/sQVe/tau/commit/81ee47c4f16bc6e558f24be081a802408d65a3ab) Thanks [@sQVe](https://github.com/sQVe)! - Add commit skill with typed tool, tree-sitter-bash guard, and TUI confirmation gate.

- [#21](https://github.com/sQVe/tau/pull/21) [`535facd`](https://github.com/sQVe/tau/commit/535facd1967bfc5234edef014965aa58434a2c48) Thanks [@sQVe](https://github.com/sQVe)! - Add prompt snippets. Press `ctrl+q` or run `/snippets` to pick single-purpose instructions that are
  added before or after your next message. Toggles turn off after each send. Snippets are skipped for
  a message that starts with a slash, because Pi expands skill and template commands only at the start
  of the text. Snippet files are read from disk on every send, so edits apply without reloading Pi.

- [#12](https://github.com/sQVe/tau/pull/12) [`21c6605`](https://github.com/sQVe/tau/commit/21c660529c9cb522c0ed95b0bb26eeb4994f119a) Thanks [@sQVe](https://github.com/sQVe)! - Remove the config, workspace state, and TDD runner modules, which no extension imported, along with
  the `proper-lockfile` and `web-tree-sitter` dependencies and the vendored bash grammar.
  
  Harden the commit tool's staging guarantee: sensitive-path patterns now match in subdirectories and
  ignore case, paths are compared in repository-root space so the tool works from a subdirectory,
  `--literal-pathspecs` stops an argument being read as a glob, and the staged set is verified both
  after staging and after the commit, so a directory argument or a pre-commit hook cannot slip in
  files nobody named.
  
  Replace the tree-sitter commit guard with a single pattern that also catches environment prefixes,
  wrappers, `commit-tree`, and shell-escaped spellings, while leaving paths under `commit/` alone.

- [#27](https://github.com/sQVe/tau/pull/27) [`fbd8fa6`](https://github.com/sQVe/tau/commit/fbd8fa6d379c3fe77e5251b4c57146cd5ed57168) Thanks [@sQVe](https://github.com/sQVe)! - Replace Pi's terminal footer with one line showing the directory, branch, dirty marker, cost,
  context usage, model, and thinking level. The right group truncates first on narrow terminals. Use a
  muted Latte palette with a dim gray directory, teal branch, and unchanged terminal background. Strip
  terminal controls from displayed names. Extension statuses no longer appear in the footer. An ochre
  open-lock glyph after the branch shows an explicitly disabled TDD gate or unreadable gate state. Use
  `run_tests` or `/tdd status` for detailed TDD feedback.

- [#19](https://github.com/sQVe/tau/pull/19) [`9c79b10`](https://github.com/sQVe/tau/commit/9c79b1058ae44371ca2db087d793562580311e86) Thanks [@sQVe](https://github.com/sQVe)! - Enforce TDD with test evidence: `run_tests` records red, green, and verified per behavior; file-tool
  writes to files matching the production globs are blocked until a focused test has failed through
  tau's runner; skipped or deleted tests never count; evidence persists to `.tau/state.json` per
  worktree. The gate turns off with a notice when no test runner resolves from the worktree, and
  `/tdd on|off|status` switches it per worktree with the opt-out recorded in the evidence file.

- [#26](https://github.com/sQVe/tau/pull/26) [`6917c97`](https://github.com/sQVe/tau/commit/6917c97c58cc15cfb68f34ab2ed87b014fc30819) Thanks [@sQVe](https://github.com/sQVe)! - Allow one TDD behavior to name several tests. Each named test must fail in RED and pass in GREEN.
  Focused passes accept test edits and report them during full verification. GREEN permits cleanup;
  changed inputs invalidate passing results. Full runs name stale inputs and explain how to renew
  them. Returning to an earlier behavior keeps its RED, including after verification. The `behavior`
  label no longer forms part of the behavior's identity.
  
  Allow new, empty production files before RED so tests can import missing modules. Existing files
  remain guarded. Paths outside the worktree stay ungated, but symlink aliases cannot bypass protected
  paths or production globs. Reject dangling symlinks and malformed stored evidence before they can
  authorize writes. Run Vitest with Node when Pi is a compiled executable.
  
  Label committed-title coverage as an estimate, and keep the TDD skill focused on the test cycle and
  recovery steps.
  
  Run the root `package.json` check script on each staged candidate before commit approval. Failed
  checks and check-time changes to tracked files block the commit. Use installed root dependencies; do
  not install packages. Report missing check scripts as unavailable instead of treating them as a
  passing check.

- [#25](https://github.com/sQVe/tau/pull/25) [`169d9cb`](https://github.com/sQVe/tau/commit/169d9cb9ffb4f3a07c77d0a9910b21d0ac589f70) Thanks [@sQVe](https://github.com/sQVe)! - Add the `tdd` skill, which explains the red-green-verified cycle that `run_tests` enforces and how
  to recover a locked phase.

- [#2](https://github.com/sQVe/tau/pull/2) [`122a069`](https://github.com/sQVe/tau/commit/122a069d29674765e3643fa69f2e6623547a1773) Thanks [@sQVe](https://github.com/sQVe)! - Settle application structure under `src/`, tighten oxlint and oxfmt rulesets, add the ast-grep
  `types-before-runtime-code` rule, and scaffold the documentation system (ADRs 0001-0004,
  policy/guide/foundation templates, writing rules).

- [#23](https://github.com/sQVe/tau/pull/23) [`bb91ea3`](https://github.com/sQVe/tau/commit/bb91ea3bf59c61e0fcd8454453d3e7c23d1f8b05) Thanks [@sQVe](https://github.com/sQVe)! - Navigate Tau's menus with vim keys. `j` and `k` move, `g` and `G` jump to the ends, in the snippet
  menu, its preview, the commit approval list, and the comment review report. The arrow keys, `home`,
  and `end` keep working. The commit overlay's Skip shortcut moves from `k` to `x`, since `k` now
  means up.

- [#24](https://github.com/sQVe/tau/pull/24) [`10b603e`](https://github.com/sQVe/tau/commit/10b603e91fd609ac71aa5ec779e81d5a15190971) Thanks [@sQVe](https://github.com/sQVe)! - Bundle the `pi-web-access` package so Pi loads its `web_search` and `fetch_content` tools with Tau.
  Tau checks at session start that both tools are registered and reports an extension error when
  either is missing. The TDD guard passes both tools through, since it blocks every tool it does not
  recognize and would otherwise reject them as unrecognized edits.

### Patch Changes

- [#26](https://github.com/sQVe/tau/pull/26) [`6917c97`](https://github.com/sQVe/tau/commit/6917c97c58cc15cfb68f34ab2ed87b014fc30819) Thanks [@sQVe](https://github.com/sQVe)! - Return cancellation when a commit's project check is aborted. Use a junction to share candidate
  dependencies on Windows, and preserve tracked `node_modules` content in the candidate checkout.
  
  Guard relative writes from a symlinked working directory against its canonical path. Discover
  `nodejs` on PATH when Pi runs as a compiled executable. Clarify that TDD behavior labels may change
  while test names and files stay fixed through the cycle.

- [#4](https://github.com/sQVe/tau/pull/4) [`abf7b91`](https://github.com/sQVe/tau/commit/abf7b91dc7f3adab53adb92e3ece6af8ab8e1ae1) Thanks [@sQVe](https://github.com/sQVe)! - Fix the Changesets release flow so merging the release PR creates a tagged GitHub Release for the
  private package.

- [#5](https://github.com/sQVe/tau/pull/5) [`16ab38d`](https://github.com/sQVe/tau/commit/16ab38d1cc0d19cf92614af7e3f1057a1e9ac40b) Thanks [@sQVe](https://github.com/sQVe)! - Improve commit failure diagnostics by including trimmed hook output in `CommitFailedError` messages,
  and add coverage for the whitespace-only stderr fallback case.

- [#9](https://github.com/sQVe/tau/pull/9) [`1a8a14a`](https://github.com/sQVe/tau/commit/1a8a14a0a98bfa98117a8a193923903dda51e351) Thanks [@sQVe](https://github.com/sQVe)! - Add integration coverage for the commit flow against a real pi `AgentSession`, driven by the faux
  provider from `@mariozechner/pi-ai`, and record the testing strategy in ADR 0005.

- [#8](https://github.com/sQVe/tau/pull/8) [`959b778`](https://github.com/sQVe/tau/commit/959b778b7e45ecfe2c547d0d5032610cdfb526f5) Thanks [@sQVe](https://github.com/sQVe)! - Consolidate development tooling, preserve lint rules across the Vite+ upgrade, and verify Pi package
  loading in the test suite. Remove the unused workspace-state schema import while keeping its export.
  
  Update dependencies and enforce type-aware promise and unsafe-value checks.
