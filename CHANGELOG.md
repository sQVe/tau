# tau

## 1.0.0

### Major Changes

- [#20](https://github.com/sQVe/tau/pull/20)
  [`7cf58d2`](https://github.com/sQVe/tau/commit/7cf58d2f88448a64c3fd1a358e96c053d65db0d9) Thanks
  [@sQVe](https://github.com/sQVe)! - Update comment review to use the session's model registry and
  migrate schemas to TypeBox 1.x.

### Minor Changes

- [#45](https://github.com/sQVe/tau/pull/45)
  [`7ea0bab`](https://github.com/sQVe/tau/commit/7ea0bab2bd4216c31b4eb9cbae5e47a7a50da87b) Thanks
  [@sQVe](https://github.com/sQVe)! - Replace blocking TDD enforcement with short, nonblocking
  session-local hints. Keep actual test reports when inputs change or freshness is unknown.
  Full-suite passes no longer require prior RED or focused renewal after formatting. Remove saved
  TDD permissions, `/tdd`, and gate notices without changing commit checks, review, or approval. Add
  the `tdd` skill to guide focused tests and full verification without edit permissions.

- [#180](https://github.com/sQVe/tau/pull/180)
  [`da2b48e`](https://github.com/sQVe/tau/commit/da2b48e21cc259a5f2dc0e640fcc793a921bc833) Thanks
  [@sQVe](https://github.com/sQVe)! - Refuse any model outside an `allowedModels` list in
  `~/.pi/agent/tau.json`. A trusted repository's `.pi/tau.json` can only remove models from that
  list, and a repository list that adds one is an error. The list covers subagent launches,
  configured worker models, saved worker replays, the `bulk_read` model, and an `answerModel` passed
  to web answers. A refusal names the model, the effective list, and the files it came from, and Tau
  never falls back to another model. Without the list, nothing changes.

- [#74](https://github.com/sQVe/tau/pull/74)
  [`3ee3d7a`](https://github.com/sQVe/tau/commit/3ee3d7a70d82ff56ff92ca0ca851c3c3db91ceed) Thanks
  [@sQVe](https://github.com/sQVe)! - Send subagent tools and notices only the worker fields the
  model needs. `subagent_status`, `subagent_follow_up`, and `subagent_cancel` return a named
  allowlist instead of the full saved record, while `details` keeps the full object for renderers.
  `recovery`, `capacityHeld`, `unconfirmedChildren`, and `descendantEvidence` appear only for
  `cleanupUnconfirmed` and `notOwned`, and record directories and native file paths leave the model
  content.

  Notices are now status snapshots taken when sent, delivered as a steer for questions and as a next
  turn message otherwise. A notice without `state` means the parent could not read the task records;
  inspect its `recovery`. When saved records are unreadable, `subagent_status` now returns that same
  shape with `recovery` instead of an error. Submission receipts narrow to `{id, state?, detail?}`,
  Pi reply content includes `questionId`, and tool descriptions explain the worker states, reply
  delivery values, and follow-up eligibility.

- [#18](https://github.com/sQVe/tau/pull/18)
  [`f07a357`](https://github.com/sQVe/tau/commit/f07a3576220750c0046620ccea2b8b2e7d6bb62d) Thanks
  [@sQVe](https://github.com/sQVe)! - Bundle the `@juicesharp/rpiv-ask-user-question` package so Pi
  loads its `ask_user_question` tool with Tau. Tau checks at session start that the tool is
  registered and reports an extension error when it is missing.

- [#15](https://github.com/sQVe/tau/pull/15)
  [`0e843e4`](https://github.com/sQVe/tau/commit/0e843e49e73621e261556bd921c50a24df88519a) Thanks
  [@sQVe](https://github.com/sQVe)! - Load plain-language writing instructions into every ordinary
  Pi agent run. Keep the instructions beside the writing extension and report an error if they are
  missing or blank.

- [#77](https://github.com/sQVe/tau/pull/77)
  [`76a04c0`](https://github.com/sQVe/tau/commit/76a04c061c86a41e54844cc078eddd03e593eb83) Thanks
  [@sQVe](https://github.com/sQVe)! - Give editing workers the complete outcome: acceptance
  criteria, the assignment baseline, editing ownership of a worktree the parent gives to one editor,
  and the Changes, Evidence, Decisions, and Concerns handoff. Pi and generic herdr workers receive
  the same contract, while investigators keep their read-only boundary.

  Saved handoffs ask for a content reference captured at check time: a saved full diff plus hashes
  of relevant untracked files, alongside the assignment baseline. A separate output path names the
  check result, and the worker states when the current work cannot be compared to that reference.
  Status marks which handoff section headings a saved report is missing, so older or incomplete
  reports stay honest without reading evidence strings.

  Wake the parent manager for terminal worker notices, including success, failure, incomplete, and
  undelivered outcomes, so an idle manager reacts without a new user prompt. Question notices keep
  steering.

  Treat a saved report as the worker handoff. Its reported checks are reusable evidence for the work
  state they name; repeat a check only for a concrete reason. Review still reads the diff, and
  accepting evidence is not accepting correctness.

  Run one full suite: a repository full check satisfies full verification, so do not repeat the
  suite only for bookkeeping.

- [#63](https://github.com/sQVe/tau/pull/63)
  [`7a2623a`](https://github.com/sQVe/tau/commit/7a2623ae9706bc8611de9de95605bc5652c9bedf) Thanks
  [@sQVe](https://github.com/sQVe)! - Allow nested Pi workers with exact inherited model and safety
  settings. Root workers and descendants share one saved capacity cap, with immediate full or busy
  refusal instead of a queue. Waiting and uncertain work retain capacity until cleanup is confirmed.
  Preserve child results without bypassing pending parent clarifications.

- [#56](https://github.com/sQVe/tau/pull/56)
  [`f93cbc4`](https://github.com/sQVe/tau/commit/f93cbc439ca79cc3b9bd1d9abdb42e1305fcf85c) Thanks
  [@sQVe](https://github.com/sQVe)! - Add trusted Pi investigator and editing workers in herdr.
  Bundle CC Safety Net as a runtime integration so clean installs can launch workers. Keep CC Safety
  Net active, save validated handover records and native session references, and bound cancellation
  attempts with a parent-owned deadline. Refuse unavailable models and unsupported harnesses without
  automatic retries.

  Bundled roles use medium effort, adjusted to the model's supported level, without model or effort
  settings in their markdown. Keep existing custom profile settings and explicit model selection.
  Accept blank and comment lines in profile frontmatter without relaxing validation.

  Honor the parent's extension-discovery selection and replay validated integrations without
  rediscovering disabled packages. Detect worker exits before readiness. Attempt owned cleanup even
  when receipt I/O fails, and retain native references and manual cleanup details in errors.

- [#201](https://github.com/sQVe/tau/pull/201)
  [`766b808`](https://github.com/sQVe/tau/commit/766b8089196e2e6dadfbfcf418184e5dde2c87e1) Thanks
  [@sQVe](https://github.com/sQVe)! - Deliver Tau's instructions to Claude models through
  `pi-claude-bridge`. Tau now adds the coding, writing, and workflow instructions, the bare-root
  rule, worker instructions, and the manager, `bulk_read`, and `commit` guidelines to Pi's
  `appendSystemPrompt` instead of replacing the system prompt, which the bridge dropped. A worker
  notice that arrives while the parent is idle now starts the turn with a short user message, so
  that turn keeps the instructions. `pnpm check` fails when the installed `pi` differs from Tau's Pi
  dependency in minor version.

- [#1](https://github.com/sQVe/tau/pull/1)
  [`24c8e0a`](https://github.com/sQVe/tau/commit/24c8e0a6ae10bc7d8352ca45cfb34c85d7effa2b) Thanks
  [@sQVe](https://github.com/sQVe)! - Set up the Tau repository with project documentation,
  TypeScript and Vite+ tooling, required checks, and automated workflows for CI, changesets, and
  releases.

- [#60](https://github.com/sQVe/tau/pull/60)
  [`bbb1155`](https://github.com/sQVe/tau/commit/bbb1155c04269b752f25eea5554e9aca35376336) Thanks
  [@sQVe](https://github.com/sQVe)! - Add the `/bro` command. It runs the bro skill like `/commit`
  runs the commit skill.

- [#17](https://github.com/sQVe/tau/pull/17)
  [`ed1b1c8`](https://github.com/sQVe/tau/commit/ed1b1c8eacd270e8a9d1a5d75b2638d945f907ea) Thanks
  [@sQVe](https://github.com/sQVe)! - Add the bro skill. It restates the previous message in plain
  language: what happened, what it means, and what to do next, without re-running the work or
  changing the reported outcome.

- [#237](https://github.com/sQVe/tau/pull/237)
  [`e924b26`](https://github.com/sQVe/tau/commit/e924b2667a3b3900e231edc0c1a81e773c9982fc) Thanks
  [@sQVe](https://github.com/sQVe)! - Add a bundled `browser` subagent profile for browser work the
  manager delegates, such as lookups, forms, page checks, and screenshots. It loads
  `npm:pi-agent-browser-native` and does not edit the worktree. Like every profile, it needs a
  model: add a `profiles.browser` entry to `~/.pi/agent/tau.json`, or rely on `profiles.default`.
  The manager now sends browser work to it. When a worker needs a login, the manager asks the user
  to sign in once in the browser package's Chrome profile, then cancels the waiting worker and
  starts a new one. Set `browser.loginCommand` in the user `tau.json` to have the manager name the
  command that opens that profile. Only the user file may set it.

  Add a `browser` instruction set with the rules that keep the configured Chrome profile: automatic
  sessions, no explicit profile or browser path, no new profile folders, a check that the page is
  signed in, a stop on a login wall unless the task gives credentials, and the `close` command at
  the end. The `browser` and `qa` profiles load it. Profiles without `instruction-sets:` still load
  `writing`, `coding`, and `workflow`, and the manager does not load the browser rules.

  Task records move to format 7, which allows the `browser` set. Follow-ups of older tasks keep
  their sets.

  After this release, remove `npm:pi-agent-browser-native` from `packages` in your Pi settings if
  the manager should no longer use the browser itself.

- [#35](https://github.com/sQVe/tau/pull/35)
  [`02b4d3a`](https://github.com/sQVe/tau/commit/02b4d3a5776a112d1250588246cd4fc97e9f2556) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `bulk_read`, which asks a configured model for concise
  answers about files, and a 400-line read clamp with a `bulk_read` hint.

- [#179](https://github.com/sQVe/tau/pull/179)
  [`dc3f6af`](https://github.com/sQVe/tau/commit/dc3f6afb33b9e8c7d8a9c699be1f65b5b571af2c) Thanks
  [@sQVe](https://github.com/sQVe)! - Cap worker reports in parent notices and `subagent_status`
  results at 8,000 characters of summary and evidence. A capped result carries `truncated: true` and
  `reportFile`, the path of the saved report, which keeps the full text.

- [#64](https://github.com/sQVe/tau/pull/64)
  [`757287e`](https://github.com/sQVe/tau/commit/757287e1e78937a52ff34a277f487c1d2228dbf3) Thanks
  [@sQVe](https://github.com/sQVe)! - Add Claude Code investigators and editing workers. Select
  `harness: claude` or use a profile with `cli: claude`, and provide a Claude model. Workers share
  Tau's records, questions, nested delegation, deadlines, and cancellation. Follow-ups can resume a
  completed worker's native conversation after confirmed cleanup.

  Claude workers require saved `bypassPermissions` settings with startup confirmation skipped, plus
  an enabled CC Safety Net plugin that passes Tau's safety probe. Tau passes no permission flag.
  Native delegation and questionnaires are unavailable; workers use Tau's parent-owned tools
  instead.

  Worker status includes available native Claude token counts, not subscription allowance or
  invoiced cost.

- [#29](https://github.com/sQVe/tau/pull/29)
  [`644fdd7`](https://github.com/sQVe/tau/commit/644fdd7018146341e554d9217bbbe7f37fb156bc) Thanks
  [@sQVe](https://github.com/sQVe)! - Require a language tag on every code block in the writing
  instructions.

- [#162](https://github.com/sQVe/tau/pull/162)
  [`e9931e1`](https://github.com/sQVe/tau/commit/e9931e17a8bdbaa3d5141cff8a32250644d41672) Thanks
  [@sQVe](https://github.com/sQVe)! - Add the `/code-review` command and skill. It reviews a branch,
  uncommitted work, a commit or range, or named files. A fast review, the default, uses one fresh
  reviewer that checks its own findings. `/code-review deep` adds a fresh checker that tests each
  finding and looks for omissions. Each finding states whether it was checked independently.

- [#28](https://github.com/sQVe/tau/pull/28)
  [`4f0f242`](https://github.com/sQVe/tau/commit/4f0f2427f40682dfcab6311bd64a7fcf3d3bf881) Thanks
  [@sQVe](https://github.com/sQVe)! - Add coding instructions to every ordinary agent run. They
  require blank lines between logical steps inside a function. Move the rules about which comments
  to keep from the writing instructions to the coding instructions. One file governs text and the
  other governs code.

- [#70](https://github.com/sQVe/tau/pull/70)
  [`b0823bf`](https://github.com/sQVe/tau/commit/b0823bfba99e5d3509d45babb258e573b49132af) Thanks
  [@sQVe](https://github.com/sQVe)! - Add three test rules to the coding instructions. Each test
  defends one behavior a caller can observe. A refusal test asserts the error and that nothing else
  changed. Assertions stay out of fakes and callbacks whose errors production code may catch.

- [#14](https://github.com/sQVe/tau/pull/14)
  [`e895c12`](https://github.com/sQVe/tau/commit/e895c12e27e22d070b6be930078c2d7b80d79246) Thanks
  [@sQVe](https://github.com/sQVe)! - Review staged comments before commit approval using the
  session model. Return blocking findings for up to two automatic correction attempts, keep
  missing-comment suggestions advisory, and require an explicit user waiver for unresolved findings
  or failed reviews. Recheck changed content, including changes made by commit hooks.

- [#22](https://github.com/sQVe/tau/pull/22)
  [`456c93c`](https://github.com/sQVe/tau/commit/456c93c73b13dfede49bda046e94e4e8c294556a) Thanks
  [@sQVe](https://github.com/sQVe)! - Accept all logical commit groups in one `commit` tool call.
  Run each group's review and approval overlay in order. Press `A` to approve all remaining groups.

- [#11](https://github.com/sQVe/tau/pull/11)
  [`16ae186`](https://github.com/sQVe/tau/commit/16ae186407a7ec9b075f12f93d325c4cd6654db7) Thanks
  [@sQVe](https://github.com/sQVe)! - Replace the commit tool's yes/no confirmation dialog with an
  overlay showing the subject, body, and per-file diff statistics. Offer choices to approve, edit
  the subject, edit the body, skip, or abort.

- [#32](https://github.com/sQVe/tau/pull/32)
  [`30c64ea`](https://github.com/sQVe/tau/commit/30c64eaffbee20b7fdd7c2ef175117fd56f4d4cf) Thanks
  [@sQVe](https://github.com/sQVe)! - Add `--auto-approve-commits` for unattended Pi runs. Commit
  confirmation is skipped, including when no UI is available. Checks and comment review still apply.
  Reviews needing a human waiver return an error instead of opening a dialog. Normal runs still
  require confirmation.

- [#3](https://github.com/sQVe/tau/pull/3)
  [`81ee47c`](https://github.com/sQVe/tau/commit/81ee47c4f16bc6e558f24be081a802408d65a3ab) Thanks
  [@sQVe](https://github.com/sQVe)! - Add a commit skill with a typed tool, a tree-sitter-bash
  guard, and required terminal confirmation.

- [#48](https://github.com/sQVe/tau/pull/48)
  [`c315245`](https://github.com/sQVe/tau/commit/c31524583905da803fb5f83fece6e28aadb3e917) Thanks
  [@sQVe](https://github.com/sQVe)! - Commit without human approval in every mode. Remove the
  approval overlay, message editor, and startup preapproval flag. Failed message checks and blocking
  comment reviews return tool errors. Preparation-added files require explicit assignment in a new
  call. Preparation, recovery, and checks remain enabled.

- [#239](https://github.com/sQVe/tau/pull/239)
  [`dd44b9e`](https://github.com/sQVe/tau/commit/dd44b9eb8d06db4d33f3c4bf915c0baf2092ad5a) Thanks
  [@sQVe](https://github.com/sQVe)! - Suggest `/compact` once a manager session's context passes
  200,000 tokens. Tau shows the notice once per crossing and never compacts by itself.

  After a compaction, the manager gets a list of its workers that have not stopped and their pending
  question IDs with the next prompt. Tau sends nothing when every worker has stopped with no pending
  question.

  A worker notice that arrives during `/compact` now joins the next prompt instead of starting a
  turn beside the summary.

- [#195](https://github.com/sQVe/tau/pull/195)
  [`36de202`](https://github.com/sQVe/tau/commit/36de2026d619ed50e5298dabe878f6b7e9a81f0e) Thanks
  [@sQVe](https://github.com/sQVe)! - Put user decisions first in replies. Number each decision, say
  what it changes, and give lettered options with the recommendation first.

- [#138](https://github.com/sQVe/tau/pull/138)
  [`d5be875`](https://github.com/sQVe/tau/commit/d5be87542aa458ded3020725c714e2c5670198d0) Thanks
  [@sQVe](https://github.com/sQVe)! - `timeoutSeconds` is optional: investigation profiles get 30
  minutes and editing profiles 60. A launch at the worker cap now lists the live workers with their
  deadlines and says to retry after a stop notice.

- [#74](https://github.com/sQVe/tau/pull/74)
  [`3ee3d7a`](https://github.com/sQVe/tau/commit/3ee3d7a70d82ff56ff92ca0ca851c3c3db91ceed) Thanks
  [@sQVe](https://github.com/sQVe)! - Replace the subagent status lifecycle flags with one derived
  `state`. `subagent_status` now reports `starting`, `running`, `awaitingReply`, `reported`,
  `stopping`, `stopped`, `cleanupUnconfirmed`, or `notOwned`, plus `recovery` for
  `cleanupUnconfirmed` and `notOwned`. `outcome` is omitted until a report, terminal event, settled
  record, or cleanup exists. Generic workers report `nativeState` only for an owned live handle.

  Replies now return a `delivery` value: `sent`, `uncertain`, `notResent`, or `notDelivered`. Pi
  replies never throw after the reply is saved.

  `subagent_history` drops `sourceFile`, `rootSessionId`, `rootSessionFile`, and the paging and
  retrieval metadata. Candidates carry `state`, exclude the current session and its ancestors, and
  include `reportFile` only when report fields are truncated. `nativeSessionFile` appears only for
  native-only sessions or unavailable native evidence.

- [#246](https://github.com/sQVe/tau/pull/246)
  [`8722989`](https://github.com/sQVe/tau/commit/8722989e755d19b74522f3759222c6476bfafbeb) Thanks
  [@sQVe](https://github.com/sQVe)! - Add the `diagram` skill. Agents use it when they explain how
  parts of a system connect, and draw Mermaid diagrams that Pi renders in the terminal instead of
  showing raw source. Run `/diagram <topic>` to get an explanation of that topic with one or more
  diagrams.

- [#51](https://github.com/sQVe/tau/pull/51)
  [`9be221d`](https://github.com/sQVe/tau/commit/9be221dc5091ee7d738335e693166508c26e15bc) Thanks
  [@sQVe](https://github.com/sQVe)! - Stage commit groups directly on the real index and use
  installed Git hooks. Remove preparation, recovery archives, and Tau-run project and message
  checks. The commit tool no longer reads `tau.json`. Comment review and guards against hook
  rewrites remain in place.

  Reject directory requests before staging. Preserve unexpected concurrent staging and clean up
  hook-added files from the repository root, including when called from a subdirectory.

- [#161](https://github.com/sQVe/tau/pull/161)
  [`ecab845`](https://github.com/sQVe/tau/commit/ecab8453993402320e8a233f004d460a5998e8b3) Thanks
  [@sQVe](https://github.com/sQVe)! - Run each Pi worker as its pane's own process instead of typing
  Pi into a shell. A Pi worker that finishes, is cancelled, or times out no longer leaves its pane
  or an empty "Tau workers" tab behind. Pi workers started by an earlier Tau cannot be reattached;
  start a fresh task instead.

- [#61](https://github.com/sQVe/tau/pull/61)
  [`d5645b5`](https://github.com/sQVe/tau/commit/d5645b58412c28cf012dc5e8bbdc46a309ff1ea5) Thanks
  [@sQVe](https://github.com/sQVe)! - Let active Pi workers ask their parent for clarification
  without exiting. Save validated questions, replies, and worker acknowledgements separately.
  Deliver replies once through herdr after checking the original worker identity. Preserve the
  assigned scope, saved settings, and original parent-owned deadline while waiting. A waiting worker
  stops when its parent controller closes or its process exits, since no reply can arrive.

  Recover pending questions and reply receipts with `subagent_status`. Repeated recovery preserves
  accepted content and does not resend uncertain deliveries. Acknowledgement records worker receipt,
  not successful side effects. Saved evidence after parent exit does not imply continuing
  enforcement.

  Use versioned provider fingerprints for new workers so resolved API-key rotation can preserve
  saved settings. Keep legacy hashes strict and refuse changed headers or configuration. New
  fingerprints also bind the complete `models.json` file, so unrelated edits to that file require a
  fresh task. Compare live provider settings, including resolved keys, with a fresh reconstruction
  at launch, saved-loadout validation, and worker startup. Refuse differing current keys, including
  rotation during validation, because they cannot be distinguished from stale literal configuration.
  Rotation between resolution and startup remains supported when current settings agree. Validate
  saved loadouts without rediscovering profiles.

  Persist role-prefixed, two-character Nano ID worker names alongside full task IDs. Check retained
  parent-session names and all live herdr names before publication, with bounded collision attempts.
  Failed live listing and uncertain startup never trigger a launch retry.

  Add read-only `subagent_history` for the current root session and its validated descendants.
  Return clarification candidates for ambiguous names, IDs, or descriptions. Retain reports and
  native references after pane cleanup or missing transcripts. History does not grant reply/cancel
  ownership, resume work, or copy transcripts. Older records remain unnamed.

  Page bounded history previews without changing full-match ambiguity. Keep source-file references
  for complete records. Include explicit current and ancestor session files regardless of filename
  extension, and merge discovered metadata without duplicate candidates.

  Add explicit `subagent_follow_up` for an exact saved task in the authorized root-session tree.
  Require a valid final handover and confirmed parent cleanup. Start a new task ID, friendly name,
  and bounded deadline on the same native session, with unchanged saved settings and original native
  lineage. Preserve earlier task/report records and keep same-task restart refused.

  Claim one successor per predecessor before native opening. Recheck the existing regular native
  file and refuse known live writers. Preserve uncertain claims and preparation evidence; never
  retry or reclaim by age. Claims coordinate Tau launchers, not arbitrary manual Pi writers. History
  shows validated continuation chains without choosing their newest task automatically.

- [#105](https://github.com/sQVe/tau/pull/105)
  [`5b1f517`](https://github.com/sQVe/tau/commit/5b1f51737cf9a981c7404f7c0c299c0d1862df8a) Thanks
  [@sQVe](https://github.com/sQVe)! - Start Pi workers from explicit settings: the requested or
  profile model as provider/id and the saved Pi configuration. Tau no longer reloads the parent's
  extensions or fingerprints its runtime, so workers on providers that register once per process,
  such as claude-bridge, launch again. A missing worker model names the configured models.
  Follow-ups replay the saved model, thinking, cwd, and agent directory only. Earlier task records
  are skipped as retired.

- [#34](https://github.com/sQVe/tau/pull/34)
  [`36bdff4`](https://github.com/sQVe/tau/commit/36bdff4a20b694ac3568efbd007c8bb8bed29bbd) Thanks
  [@sQVe](https://github.com/sQVe)! - Configure commit commands with optional `prepare` and `check`
  argv arrays in root `tau.json`. Preparation runs once per executed staged group. Checks use the
  staged candidate's own config. Remove package-script and package-manager discovery; report missing
  commands without fallback. Reject malformed or unknown settings, and tell users to rename obsolete
  `fix` to `prepare`. Message checks and hook policy are now selected by the staged candidate. Keep
  human Git hooks and commit guards independent of Tau's final-commit hook policy. Tau's staged hook
  checks lint and formatting without rewriting approved files.

- [#65](https://github.com/sQVe/tau/pull/65)
  [`40efcee`](https://github.com/sQVe/tau/commit/40efceeca3cbd8fc03f0c0fbde17ee801769c79b) Thanks
  [@sQVe](https://github.com/sQVe)! - Replace the Claude execution bridge with one generic herdr
  workflow for non-Pi workers. Native configuration needs explicit user approval. Native controls
  remain in force, but Tau does not verify their enforcement or the model used. Completed report
  files provide durable handover; plain-text delivery does not imply task acceptance.

  Keep Pi's safety checks, questions, reports, nesting, and native follow-ups. Saved Pi worker
  records now require the current shape: an explicit `pi` harness, provider fingerprint version 2,
  the `noExtensions` audit field, and tree ancestry. Records from an earlier saved format, including
  retired Claude records, are not read, migrated, or continued; start a fresh task. Native waits
  keep their original deadline, and uncertain delivery or cleanup never triggers an automatic retry.

- [#97](https://github.com/sQVe/tau/pull/97)
  [`3bb44e4`](https://github.com/sQVe/tau/commit/3bb44e4bdd9d3c47bad1d4abe30e37a8200dc0e5) Thanks
  [@sQVe](https://github.com/sQVe)! - Add the handoff skill. When work belongs in another workspace,
  the agent sends a one-way message through a file to the herdr agent there instead of editing,
  testing, or committing that worktree itself.

- [#74](https://github.com/sQVe/tau/pull/74)
  [`3ee3d7a`](https://github.com/sQVe/tau/commit/3ee3d7a70d82ff56ff92ca0ca851c3c3db91ceed) Thanks
  [@sQVe](https://github.com/sQVe)! - Keep the reason on worker notices and records. Collapsed
  status lines now show a startup failure, an undelivered or uncertain assignment, and a blocked or
  unknown native state for every live state, as a short fixed phrase; ctrl+o shows the full reason.
  `subagent_status` content includes a bounded `observationIssue`, and a pending question gains
  `replySaved: true` once its reply is saved.

  `subagent`, `subagent_follow_up`, and `subagent_cancel` return the unreadable-evidence object
  instead of an error when saved records cannot be read. A corrupt acknowledgement record no longer
  makes a saved Pi reply look failed, `subagent_history` no longer lists the calling worker's own
  task or its parent task, and a result saved with an old prose delivery value falls back to Pi's
  default rendering.

- [#99](https://github.com/sQVe/tau/pull/99)
  [`2bab28b`](https://github.com/sQVe/tau/commit/2bab28b942315b1518701804fea2116893c9c696) Thanks
  [@sQVe](https://github.com/sQVe)! - Show aligned live worker progress and browse grouped worker
  history, reports, recovery details, model observations, and available Pi usage. Worker panes
  display their name with the harness and a known model, and unresolved worker states use explicit
  counts instead of a generic attention label. Worker details include the latest phase description
  and its report time.

  The compact widget lists worker name, status, short task name, and model. Related columns stay
  adjacent, the model is muted and drops first on narrow terminals, and unused width stays after the
  last column. The full model stays in the details view. When nothing is active or waiting, the
  widget renders one muted summary line with stopped, status-unknown, and cleanup-unconfirmed counts
  instead of a box of records that can no longer change. Those records stay in history.

  History rows show the worker name, state, short task label, optional model, and one right-aligned
  time. The filter matches the displayed label, and the full task prompt stays in the details view.
  Launch and follow-up accept an optional short label; older records fall back to the first
  meaningful task line.

  The selected details show a short task name and key facts first. The full task prompt is a
  separate section, keeps its paragraphs, and is reachable on demand. `ctrl+d` and `ctrl+u` scroll
  half a page.

- [#135](https://github.com/sQVe/tau/pull/135)
  [`ea44de4`](https://github.com/sQVe/tau/commit/ea44de402b9f1cde76565c36a2e1ff21bbb3aae8) Thanks
  [@sQVe](https://github.com/sQVe)! - Guide manager sessions inside herdr to delegate on their own.
  Managers now send non-trivial implementation to a `worker`, wide questions to a `scout`, and
  finished changes to a `reviewer` without waiting for the user to ask. They keep small edits,
  questions, and user conversation. Workers and sessions outside herdr do not get this guidance.

- [#75](https://github.com/sQVe/tau/pull/75)
  [`3e1af54`](https://github.com/sQVe/tau/commit/3e1af548131923eb3c6ff0fe1ca2f77f8acb3a3b) Thanks
  [@sQVe](https://github.com/sQVe)! - Launch non-Pi workers without a parent approval dialog. The
  dialog fired on every launch, and the model also asked the user first, so each launch cost two
  approvals for the same configuration. The sandbox checks remain: native-controls is required, the
  report directory must already exist inside the trusted cwd, and native arguments are copied as a
  literal list. The native harness's own approval dialogs remain in force; Tau adds no bypass flags
  and never answers them. Saved records that carry `configurationApproved` still validate.

- [#223](https://github.com/sQVe/tau/pull/223)
  [`236a9dc`](https://github.com/sQVe/tau/commit/236a9dce9de239c880cd3ae0d1081dc942f2b836) Thanks
  [@sQVe](https://github.com/sQVe)! - Tau no longer names a model of its own. Set every model it
  uses in `~/.pi/agent/tau.json`:

  - Workers need a launch `model`, `profiles.<name>.model`, or `profiles.default.model`. Without
    one, the launch fails and names `profiles.default.model`. Workers no longer default to
    `claude-bridge/claude-opus-5-5`.
  - `bulk_read` needs `bulkRead.model`, such as
    `{"bulkRead": {"model": "openai-codex/gpt-5.6-luna"}}`. Only the user file may set it. Without a
    usable one, the session starts with `bulk_read` and its guidelines hidden, and reads are not
    clamped. `profiles.default` does not apply.
  - `TAU_DELEGATE_MODEL` is removed.

  Tau no longer sets the web answer model. Set it with `fetch.answerProvider` and
  `fetch.answerModel` in pi-web-access's `web-search.json`; without them, web answers use the
  session model. Tau still refuses an `answerModel` passed on a call when it is outside
  `allowedModels`.

- [#204](https://github.com/sQVe/tau/pull/204)
  [`ccb4d2a`](https://github.com/sQVe/tau/commit/ccb4d2ae59a3b179861f40f7c9f66baa88824129) Thanks
  [@sQVe](https://github.com/sQVe)! - Tau now provides `ask_user_question` itself instead of
  bundling `@juicesharp/rpiv-ask-user-question`. In multi-select questions, Space checks an option
  and Enter submits from any row, so the `Next` row is gone. Text typed in "Type something." is
  returned together with the checked options instead of replacing them. Previews render below the
  option list. Notes, the review tab, collapsing, the external editor, translations, and the RPC
  dialog fallback are no longer available.

- [#108](https://github.com/sQVe/tau/pull/108)
  [`40fa194`](https://github.com/sQVe/tau/commit/40fa194fb1600dc54aca6b8f54c883d2dabd8ccc) Thanks
  [@sQVe](https://github.com/sQVe)! - Workers now ask their parent for delegation instead of
  launching workers themselves. Each parent controller caps its live workers in memory, using
  `TAU_SUBAGENT_CAP` once at startup. Tau no longer saves root-tree locks or capacity reservations.
  Earlier task records with nesting metadata are skipped as retired. Task scans also skip unreadable
  or unsupported records with diagnostics, so one checkout's records cannot hide unrelated work.
  Direct task reads still report errors. Failed task preparation does not consume a worker slot.

- [#109](https://github.com/sQVe/tau/pull/109)
  [`bde3f7e`](https://github.com/sQVe/tau/commit/bde3f7efbe3032344b1d086c3fa73c3277b79260) Thanks
  [@sQVe](https://github.com/sQVe)! - Keep worker records per Tau checkout in
  `<agentDir>/tau/<checkout>/workers/`, so a record written by one checkout never breaks another
  checkout's launch, history, or status. Tau no longer reads records in `<agentDir>/tau/workers/`
  and leaves them in place.

  Non-Pi workers now report to `<cwd>/.tau/workers/<taskId>/report.md`. The `subagent` tool no
  longer takes `reportDirectory`. Tau makes sure `.tau/.gitignore` has a `*` line so `.tau/` stays
  out of Git in any repository, and refuses a symlinked `.tau/` or `.tau/workers/`.

- [#218](https://github.com/sQVe/tau/pull/218)
  [`b45c7c9`](https://github.com/sQVe/tau/commit/b45c7c95551420e381cea6a045745e1740c3aeb2) Thanks
  [@sQVe](https://github.com/sQVe)! - Build and test Tau against Pi 0.99.0. Pi now supplies
  `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and
  `typebox`, so Tau lists them as peer dependencies with a `*` range instead of installing its own
  copies. This removes Pi's launch warning about host-provided packages in `dependencies`.

- [#244](https://github.com/sQVe/tau/pull/244)
  [`ef052a7`](https://github.com/sQVe/tau/commit/ef052a73f746dbda2c9f33964e8a0f89e52d6fbb) Thanks
  [@sQVe](https://github.com/sQVe)! - Tau now supports Pi 1.0.0.

- [#160](https://github.com/sQVe/tau/pull/160)
  [`83b6bad`](https://github.com/sQVe/tau/commit/83b6bad65021f22f7db4217e4ec5dea12f8c4d4b) Thanks
  [@sQVe](https://github.com/sQVe)! - Run subagents only as Pi workers. Claude and GPT models still
  run as Pi workers through Pi's providers. Send work for Claude Code or Codex to that agent's
  workspace with the handoff skill.

  The `subagent` tool no longer takes `harness`, `nativeArguments`, or `permissions`. Replies always
  need a `questionId`, and `subagent_status` no longer takes `submissionId` or `readOutput`. A
  profile that sets `cli:` to anything other than `pi` now fails with a message that non-Pi workers
  are no longer supported. Saved non-Pi tasks are skipped with the same message and do not block
  other tasks.

- [#230](https://github.com/sQVe/tau/pull/230)
  [`b9be7d1`](https://github.com/sQVe/tau/commit/b9be7d172ad2d0a7ef846e786c23d0300c379517) Thanks
  [@sQVe](https://github.com/sQVe)! - The `pr-feedback` skill runs one feedback round on a GitHub
  pull request. On the user's own PR it rebases onto the base when the PR conflicts, then verifies
  unresolved review comments and failing CI checks. It fixes the valid ones, pushes once, replies,
  and resolves the threads. It reports CI failures that also fail on the base or come from outside
  the PR's changes instead of fixing them. On someone else's PR it checks whether the author fixed
  the user's comments and reports failing checks and conflicts. Drafts to people are shown before
  posting.

  The pr skill writes commit SHAs in PR bodies the same way, so they link.

- [#170](https://github.com/sQVe/tau/pull/170)
  [`a80d6b1`](https://github.com/sQVe/tau/commit/a80d6b164e9a2a04493670a4d7db6e958e27e99c) Thanks
  [@sQVe](https://github.com/sQVe)! - Add the pr skill. It creates or updates the GitHub pull
  request for the current branch. It commits the task's changes and release notes, removes added
  comments that break the coding rules, and reuses or runs a fast code review and the required
  checks. It previews the title, body, base, and draft status, and pushes or publishes only after
  approval. After publishing, it offers to request bot reviews, such as Codex.

- [#34](https://github.com/sQVe/tau/pull/34)
  [`36bdff4`](https://github.com/sQVe/tau/commit/36bdff4a20b694ac3568efbd007c8bb8bed29bbd) Thanks
  [@sQVe](https://github.com/sQVe)! - Assign clean preparation-added files to a commit group through
  the overlay before checks, review, and final approval. Show added paths separately and retain
  group ownership across the batch.

  Startup-preapproved calls stop on additions for explicit assignment in a new call. Preserve
  concurrent staging and reject candidate changes during assignment. Final commit guards remain
  enabled.

- [#209](https://github.com/sQVe/tau/pull/209)
  [`0dea779`](https://github.com/sQVe/tau/commit/0dea779ba3c1a71657dd5a982cdf9f8d426aafa9) Thanks
  [@sQVe](https://github.com/sQVe)! - Load only the instruction sets each worker profile names. A
  profile's `instruction-sets:` setting lists them from `writing`, `coding`, and `workflow`; without
  it, a worker loads all three. The bundled `scout` and `qa` profiles load `writing` and `workflow`
  and no longer receive the coding instructions. A worker appends its sets from its saved task, so a
  follow-up keeps them.

  Task records move to format 5, which saves the instruction sets. Follow-ups of older tasks get all
  three sets.

- [#216](https://github.com/sQVe/tau/pull/216)
  [`504b0ba`](https://github.com/sQVe/tau/commit/504b0babd06506c53dae9c48e24a0b83267a70f0) Thanks
  [@sQVe](https://github.com/sQVe)! - Let a worker profile load its own Pi packages. A profile's
  `packages:` setting lists Pi package sources, as `pi -e` takes them. Before it opens the pane, the
  parent installs each package into Pi's temporary cache, and the worker loads it with `-e`. The
  parent session does not load it. A package that the user or project settings already load is not
  loaded twice. A failed install stops the launch and names the package. When the worker exits
  before it is ready, the failure names the packages it loaded with `-e`.

  The bundled `qa` profile now loads `npm:pi-agent-browser-native` itself and has a description.
  Users whose parent session does not use the browser can remove the package from their settings.

  Task records move to format 6, which saves the profile packages. Follow-ups of older tasks load no
  profile packages.

- [#203](https://github.com/sQVe/tau/pull/203)
  [`3aad602`](https://github.com/sQVe/tau/commit/3aad602875116e9960c8046250f2c33fff557e93) Thanks
  [@sQVe](https://github.com/sQVe)! - Give each worker only the tools and skills its profile names.
  A profile's `tools:` setting lists its tools; without it, investigation profiles get `read` and
  `bash`, and editing profiles add `edit` and `write`. The three `subagent_*` report tools are
  always added. Workers launch with Pi's `--tools` allowlist, so no extension can activate another
  tool later, and with `--no-skills`. A profile's `skills:` setting names the skills to load. A
  worker refuses to start when a listed tool is not registered, and launch fails when a listed skill
  is not found.

  The bundled profiles name the tools their workers used. `scout` keeps the web tools and
  `bulk_read`, `worker` keeps `run_tests` and `commit`, and `qa` keeps `agent_browser` and
  `agent_browser_code`. The fixed prompt of a bundled worker's first request drops from 66k
  characters to 24k–34k.

  Task records move to format 4, which saves the tools and skills. Follow-ups of older tasks get
  their role's default tools and no skills.

- [#185](https://github.com/sQVe/tau/pull/185)
  [`8f6db0b`](https://github.com/sQVe/tau/commit/8f6db0bbfd04ccf0ab52de26b428c8bd3afa27ea) Thanks
  [@sQVe](https://github.com/sQVe)! - List every available worker profile, with the `description`
  from its frontmatter, in the `subagent` tool description. The list includes profiles in
  `<agentDir>/agents` and a trusted `.pi/agents`. Worker status and notices for a live worker now
  show its latest activity phase, progress description, update time, and token usage.

- [#12](https://github.com/sQVe/tau/pull/12)
  [`21c6605`](https://github.com/sQVe/tau/commit/21c660529c9cb522c0ed95b0bb26eeb4994f119a) Thanks
  [@sQVe](https://github.com/sQVe)! - Remove the config, workspace state, and TDD runner modules,
  which no extension imported, along with the `proper-lockfile` and `web-tree-sitter` dependencies
  and the vendored bash grammar.

  Strengthen the commit tool's staging checks. Sensitive-path patterns now match in subdirectories
  and ignore case. Compare paths relative to the repository root so the tool works from a
  subdirectory. Use `--literal-pathspecs` to prevent arguments from being read as globs. Check the
  staged set after staging and after the commit. This prevents directory arguments or pre-commit
  hooks from including files nobody named.

  Replace the tree-sitter commit guard with a single pattern that also catches environment prefixes,
  wrappers, `commit-tree`, and shell-escaped spellings, while leaving paths under `commit/` alone.

- [#131](https://github.com/sQVe/tau/pull/131)
  [`b446ab0`](https://github.com/sQVe/tau/commit/b446ab09e68ec9021a1e606a6f8a270d9037324d) Thanks
  [@sQVe](https://github.com/sQVe)! - Let herdr manage pane sizes after worker placement. Workers
  use a background tab when an existing pane cannot split usefully, rather than resizing earlier
  splits. History lists saved tasks only, without discovering native-only sessions. Show elapsed
  time in compact worker rows and remove placeholder report sections from the history view.

- [#74](https://github.com/sQVe/tau/pull/74)
  [`3ee3d7a`](https://github.com/sQVe/tau/commit/3ee3d7a70d82ff56ff92ca0ca851c3c3db91ceed) Thanks
  [@sQVe](https://github.com/sQVe)! - Show subagent results and notices as readable lines instead of
  raw JSON. Each status, reply, and history result uses the same state icons and wording, with
  worker names, local deadlines, and evidence errors. Expanded rows (ctrl+o) show the full task ID,
  the deadline enforcement, the report summary and evidence, and the shortened records and session
  paths. Notices render the same way, and results saved before this change keep Pi's default
  rendering.

  History distinguishes loaded rows hidden by collapse from matches on another page. Expanded
  history shows the next offset when another page is available. Reply guidance clarifies that
  `notResent` does not confirm the original Pi delivery.

- [#115](https://github.com/sQVe/tau/pull/115)
  [`7055fb8`](https://github.com/sQVe/tau/commit/7055fb8df2ede757a93f9fb278c55339a3e19688) Thanks
  [@sQVe](https://github.com/sQVe)! - Use saved task records and herdr's live sessions to decide
  whether a worker can receive a follow-up. Ignore old claim files. Keep successor task IDs in
  status and history, and allow retries after confirmed cleanup before dispatch, acceptance, or a
  report.

- [#186](https://github.com/sQVe/tau/pull/186)
  [`da249d0`](https://github.com/sQVe/tau/commit/da249d03af6ad14fba59c77cabea6780ca79b0fd) Thanks
  [@sQVe](https://github.com/sQVe)! - Deliver worker replies through the task records instead of
  typing into the worker pane. `subagent_reply` saves the reply, and the waiting worker reads it,
  saves its acknowledgement, and continues. The reply receipt drops `delivery` and `deliveryError`;
  `workerAcknowledged` and `subagent_status` with `questionId` still show whether the worker took
  the reply. A reply saved after the worker stopped waiting stays unacknowledged.

- [#113](https://github.com/sQVe/tau/pull/113)
  [`238d924`](https://github.com/sQVe/tau/commit/238d924a07dbb2becb90b19f5e6e77927b9d667a) Thanks
  [@sQVe](https://github.com/sQVe)! - Workers no longer hold a capacity slot after cleanup ends
  unconfirmed. Their records and recovery references remain available for manual cleanup. Terminal
  identity checks still protect input and pane closure.

- [#98](https://github.com/sQVe/tau/pull/98)
  [`b165bfc`](https://github.com/sQVe/tau/commit/b165bfc9a3001b1fbf6f1c1a006ce80cb94f4fbc) Thanks
  [@sQVe](https://github.com/sQVe)! - Remove comment review from the `commit` tool. Git hooks are
  now the only commit gate, and the tool no longer accepts `commentDispute` or reports a review.

- [#110](https://github.com/sQVe/tau/pull/110)
  [`69d4002`](https://github.com/sQVe/tau/commit/69d4002dfe16ddaa6efa592dcf567eeb91276283) Thanks
  [@sQVe](https://github.com/sQVe)! - The same parent Pi session can reattach to workers after a
  restart when herdr confirms their saved identity. Reattached workers keep their original deadline.
  Cancellation can also use saved ownership when reattachment fails, without sending input to a
  changed worker. Earlier task records with controller-instance ownership are skipped as retired.

  Expired saved tasks get one cleanup attempt using their original cancellation budget, without
  extending worker work.

  Reattachment respects the parent's live-worker cap, and shutdown stops workers whose reattachment
  checks are still pending. Workers waiting for a reply survive a parent crash until the original
  deadline, while a clean parent close still ends the wait.

- [#36](https://github.com/sQVe/tau/pull/36)
  [`1a7a27c`](https://github.com/sQVe/tau/commit/1a7a27cec9946a0a9e3edf8bb5c9e0d0037452cd) Thanks
  [@sQVe](https://github.com/sQVe)! - Add snippets for pushing back on claims, ideas, and decisions,
  drafting messages in the conversation, and explaining a change to its readers. Strengthen
  verification instructions to compare before and after, separate measurements from estimates, and
  test real user flows.

- [#70](https://github.com/sQVe/tau/pull/70)
  [`b0823bf`](https://github.com/sQVe/tau/commit/b0823bfba99e5d3509d45babb258e573b49132af) Thanks
  [@sQVe](https://github.com/sQVe)! - Show test durations in `run_tests`. A focused run shows the
  duration of each selected test. A full run lists only tests that take over 1000 ms, slowest first,
  and skips `.integration.` files.

- [#55](https://github.com/sQVe/tau/pull/55)
  [`4ada8a9`](https://github.com/sQVe/tau/commit/4ada8a93f4c2f00565f3fcd0cea7f2c4b5ac2a30) Thanks
  [@sQVe](https://github.com/sQVe)! - Bulk reads use their own model, independently of Pi's session
  model. Invalid settings and model failures return errors without switching models.

  Remove `TAU_BULK_READ_MODEL`. Set `bulkRead.model` in `~/.pi/agent/tau.json` instead.

- [#249](https://github.com/sQVe/tau/pull/249)
  [`dfc474d`](https://github.com/sQVe/tau/commit/dfc474d0e6f92e03da8771296c6333a6345a335d) Thanks
  [@sQVe](https://github.com/sQVe)! - Rework the prompt snippets for `#` autocomplete into short,
  single-purpose instructions that you combine in one message, such as
  `#evidence #no-changes #wait`. Give them short ids that are easy to type, and add `#options`,
  `#minimal`, `#tdd`, `#measure`, `#edge-cases`, `#standalone`, and `#visualize`. List snippets by
  id, and drop the `order` field.

- [#62](https://github.com/sQVe/tau/pull/62)
  [`1c8753a`](https://github.com/sQVe/tau/commit/1c8753a3c6d6401cfacd6ce05711cd2f3d56b3e8) Thanks
  [@sQVe](https://github.com/sQVe)! - Share foreground space roughly equally between the parent and
  workers by adjusting only unchanged Tau-created splits. Keep replacement workers roughly equally
  sized after verified owned cleanup. Group background workers into inspectable tabs without a fixed
  worker count. Preserve focus, manual split ratios, and unrelated panes. Use a separate tab when
  the parent cannot share useful space.

  Follow stable terminal identity across workspace moves for cancellation and owned cleanup. Refuse
  missing or ambiguous ownership, and abandon placement when the inspected layout changes. Preserve
  confirmed pane references when cancellation interrupts layout inspection.

- [#221](https://github.com/sQVe/tau/pull/221)
  [`99dd64a`](https://github.com/sQVe/tau/commit/99dd64a9875b4798b5a4c1fdddc6f0edbb90081b) Thanks
  [@sQVe](https://github.com/sQVe)! - Every Tau skill now has a `/<name>` command, such as `/pr`,
  `/handoff`, and `/worktree`. Each command runs its skill, so skills work when Pi's `/skill:<name>`
  commands are turned off.

- [#232](https://github.com/sQVe/tau/pull/232)
  [`daaea2d`](https://github.com/sQVe/tau/commit/daaea2d12223ff193a94e0ed465bb04f3ce26671) Thanks
  [@sQVe](https://github.com/sQVe)! - Skills can name the actions they must own in
  `metadata.required-for` in their frontmatter. Tau adds one line per such skill to the system
  prompt, so the agent uses the skill even when the action is a step in its own plan. The `pr`,
  `pr-feedback`, `update-branch`, `worktree`, and `handoff` skills now declare their actions. Tau
  refuses to load when a `required-for` value is empty or not a string, or when a Tau skill file has
  broken frontmatter, and it names the skill file.

- [#233](https://github.com/sQVe/tau/pull/233)
  [`da66c44`](https://github.com/sQVe/tau/commit/da66c44e8123d4468315b88dbce6a4dc8883417b) Thanks
  [@sQVe](https://github.com/sQVe)! - The `slice` skill splits an agreed design into ordered,
  PR-sized slice tickets in Linear, under a container ticket when there is more than one slice. It
  shows the layout, new design choices, and every Linear write for approval before it writes
  anything. A later run shows plan changes as a new preview.

- [#247](https://github.com/sQVe/tau/pull/247)
  [`09a30e4`](https://github.com/sQVe/tau/commit/09a30e4da9067eec23854ebc94e883b2bd15a83a) Thanks
  [@sQVe](https://github.com/sQVe)! - Add prompt snippets from the editor's autocomplete. Type `#`
  to list all snippets, and type a few letters to narrow the list by name and description. A preview
  above the editor shows the text of the selected snippet. Press Tab or Enter to replace the `#`
  text with the snippet text, which you can edit before sending. Pi sends exactly what the editor
  shows, and history recalls it.

- [#234](https://github.com/sQVe/tau/pull/234)
  [`b74de76`](https://github.com/sQVe/tau/commit/b74de76cb1d685a8e22d8edf47cbcdc92ce32ff0) Thanks
  [@sQVe](https://github.com/sQVe)! - Add a `stack` skill that detects, switches, restacks, and
  pushes stacked pull requests with `gh stack`. In a stack, `pr-feedback` asks which PR to handle,
  switches to it, restacks the branches above, and pushes the stack once. It compares failing checks
  with the trunk and the PRs below instead of the parent branch. `update-branch` restacks with
  `gh stack rebase`, and `pr` adds new PRs to the stack with `gh stack link`.

- [#34](https://github.com/sQVe/tau/pull/34)
  [`36bdff4`](https://github.com/sQVe/tau/commit/36bdff4a20b694ac3568efbd007c8bb8bed29bbd) Thanks
  [@sQVe](https://github.com/sQVe)! - Support optional `checkMessage` argv and
  `hooks: "run" | "skip"` in root `tau.json`. The staged candidate selects both; hooks default to
  run. Message checks receive a temporary full-message file path and run against staged tools.
  Message edits rerun message validation without repeating preparation, project checks, or comment
  review. Failed checks cannot be waived; checker mutations stop the group. Missing message checks
  are reported unavailable.

  Preserve normalized message bytes with `git commit --cleanup=verbatim -F`. Reject NUL and undo
  commits whose hooks rewrite the checked message. Explicit staged hook bypass applies only to Tau's
  final commit, without changing human hooks or configuration. Retain review, TDD, and final
  content/path guards. Report cleanup failures without losing completed commit hashes or primary
  errors.

- [#34](https://github.com/sQVe/tau/pull/34)
  [`36bdff4`](https://github.com/sQVe/tau/commit/36bdff4a20b694ac3568efbd007c8bb8bed29bbd) Thanks
  [@sQVe](https://github.com/sQVe)! - Run configured commit preparation once per executed group
  after staging, then restage requested files before checks and review. Preserve prior staging and
  working recovery data. Stop on ownership conflicts or unassigned generated changes instead of
  accepting extra paths. Configured preparation disables speculative reviews and later-group
  approve-all reuse. Recovery requires a supported local POSIX checkout and covers up to 100 MiB of
  tracked and nonignored untracked working data. Git hooks and post-commit guards remain enabled.

- [#238](https://github.com/sQVe/tau/pull/238)
  [`874c092`](https://github.com/sQVe/tau/commit/874c092e34c5711caf55da288d33ece2ca64b6aa) Thanks
  [@sQVe](https://github.com/sQVe)! - The `start-slice` skill starts one slice of a planned design.
  It picks the next slice from order, dependencies, and merge state, then previews the branch, its
  base, and the agent tickets for one approval. After approval it creates the branch and the agent
  tickets, and hands the work to workers. Set the Linear team for agent tickets with
  `slice.agentTeam` in `~/.pi/agent/tau.json`; the manager prompt names it.

- [#27](https://github.com/sQVe/tau/pull/27)
  [`fbd8fa6`](https://github.com/sQVe/tau/commit/fbd8fa6d379c3fe77e5251b4c57146cd5ed57168) Thanks
  [@sQVe](https://github.com/sQVe)! - Replace Pi's terminal footer with one line showing the
  directory, branch, dirty marker, cost, context usage, model, and thinking level. The right group
  truncates first on narrow terminals. Use a muted Latte palette with a dim gray directory, teal
  branch, and unchanged terminal background. Strip terminal controls from displayed names. Extension
  statuses no longer appear in the footer. Use `run_tests` for test outcomes, freshness, and
  advisory TDD hints.

- [#168](https://github.com/sQVe/tau/pull/168)
  [`6eceb4d`](https://github.com/sQVe/tau/commit/6eceb4d555029bddc3262b0745a51fb2bc198342) Thanks
  [@sQVe](https://github.com/sQVe)! - Read advisory TDD config from a `tdd` block in
  `~/.pi/agent/tau.json`, overridden by a trusted repository's `.pi/tau.json`. It can set
  `productionGlobs`, `testGlobs`, `testSupportGlobs`, `excludedGlobs`, and `verificationArgv`. Each
  set field replaces the earlier value, and missing files keep the defaults. A malformed file pauses
  hints with an error that names the file and field, and `run_tests` fails instead of falling back.
  Edits and commit checks are never blocked. Each `run_tests` result shows every effective value and
  where it came from.

- [#26](https://github.com/sQVe/tau/pull/26)
  [`6917c97`](https://github.com/sQVe/tau/commit/6917c97c58cc15cfb68f34ab2ed87b014fc30819) Thanks
  [@sQVe](https://github.com/sQVe)! - Allow one TDD behavior to name several tests. Each selected
  test must fail uniquely to establish observed RED. Focused passes suggest full verification.
  Changed inputs make results stale without blocking edits, and a full pass starts the next cycle.
  The `behavior` label no longer forms part of the behavior's identity.

  Production edits, including new empty modules, do not require TDD permission. Run Vitest with Node
  when Pi is a compiled executable.

  Keep the TDD skill focused on the test cycle, outcomes, freshness, and advisory hints.

  Run the root `package.json` check script on each staged candidate before commit approval. Failed
  checks and check-time changes to tracked files block the commit. Use installed root dependencies;
  do not install packages. Report missing check scripts as unavailable instead of treating them as a
  passing check.

- [#70](https://github.com/sQVe/tau/pull/70)
  [`b0823bf`](https://github.com/sQVe/tau/commit/b0823bfba99e5d3509d45babb258e573b49132af) Thanks
  [@sQVe](https://github.com/sQVe)! - Hint when a focused test reaches RED through a thrown
  `TypeError`, `ReferenceError`, `SyntaxError`, or missing module instead of a failed assertion. The
  run still counts as RED.

- [#2](https://github.com/sQVe/tau/pull/2)
  [`122a069`](https://github.com/sQVe/tau/commit/122a069d29674765e3643fa69f2e6623547a1773) Thanks
  [@sQVe](https://github.com/sQVe)! - Put application code under `src/` and tighten oxlint and oxfmt
  rules. Add the ast-grep `types-before-runtime-code` rule. Set up ADRs 0001-0004,
  policy/guide/foundation templates, and writing rules.

- [#251](https://github.com/sQVe/tau/pull/251)
  [`4a63519`](https://github.com/sQVe/tau/commit/4a63519c3ba908a06dfae04870fd00b4357e14ad) Thanks
  [@sQVe](https://github.com/sQVe)! - The `tracker` skill writes Linear tickets by one set of rules.
  It has a template for each ticket type, routes each ticket to its team and project, and searches
  for an open duplicate before it creates one. Starting a slice moves it to In Progress; no skill
  makes any other status change. The `slice`, `start-slice`, `pr`, and `pr-feedback` skills follow
  it when they write to Linear.

  `slice.agentTeam` is now `tracker.agentTeam` in `~/.pi/agent/tau.json`, and a config that still
  sets `slice` is an error. Each repository also needs a `tracker.repositories` entry keyed by its
  `origin` remote's `owner/name`, with its team and an optional project:

  ```json
  {
    "tracker": {
      "agentTeam": "AI",
      "repositories": { "sQVe/tau": { "team": "ME", "project": "Tau" } }
    }
  }
  ```

- [#241](https://github.com/sQVe/tau/pull/241)
  [`fab0b86`](https://github.com/sQVe/tau/commit/fab0b869c4c560098f38fef2b4848a234462f1e4) Thanks
  [@sQVe](https://github.com/sQVe)! - Replace the `triage-findings` prompt snippet with a
  `triage-findings` skill. Start it with `/skill:triage-findings` when you want the agent to act on
  review findings or comments. It keeps the same rules and the same report headings: Fixed, Not
  worth changing, Incorrect, Blocked, then Checks.

- [#177](https://github.com/sQVe/tau/pull/177)
  [`b615379`](https://github.com/sQVe/tau/commit/b615379d2c298c269dc2344a8907511461b93aa0) Thanks
  [@sQVe](https://github.com/sQVe)! - Trim worker surface that carried no information.
  `subagent_reply` no longer takes `scopeUnchanged`, and `subagent_follow_up` no longer takes
  `settingsUnchanged`. The `subagent` description drops its state legend. Workers no longer save a
  `notified` event; saved tasks that still have one read as before. A profile that sets
  `session-mode` or `permissions` now fails as an unsupported setting.

  Workers now refuse `/new`, `/resume`, and `/fork`, so a worker stays in the session its task is
  bound to.

- [#23](https://github.com/sQVe/tau/pull/23)
  [`bb91ea3`](https://github.com/sQVe/tau/commit/bb91ea3bf59c61e0fcd8454453d3e7c23d1f8b05) Thanks
  [@sQVe](https://github.com/sQVe)! - Navigate Tau's menus with vim keys. `j` and `k` move, `g` and
  `G` jump to the ends, in the commit approval list and the comment review report. The arrow keys,
  `home`, and `end` keep working. The commit overlay's Skip shortcut moves from `k` to `x`, since
  `k` now means up.

- [#211](https://github.com/sQVe/tau/pull/211)
  [`4d08d15`](https://github.com/sQVe/tau/commit/4d08d15e8634105d1ee06d13938c379c88f4b01f) Thanks
  [@sQVe](https://github.com/sQVe)! - Update the bundled `pi-web-access` to 0.33.0 and load its
  compiled bundle. Parent sessions now start with only `web_enable`, which turns on the web tools
  when the model needs them. To keep them active from the first turn, set
  `"toolActivation": "eager"` in the `web-search.json` pi-web-access already reads:
  `~/.pi/agent/web-search.json`, or `~/.pi/web-search.json` when only that one exists. Workers whose
  profile lists web tools, such as `scout`, still get them active from the start.

- [#24](https://github.com/sQVe/tau/pull/24)
  [`10b603e`](https://github.com/sQVe/tau/commit/10b603e91fd609ac71aa5ec779e81d5a15190971) Thanks
  [@sQVe](https://github.com/sQVe)! - Bundle the `pi-web-access` package so Pi loads its
  `web_search` and `fetch_content` tools with Tau. Tau checks at session start that both tools are
  registered and reports an extension error when either is missing. TDD observations do not restrict
  either tool.

- [#99](https://github.com/sQVe/tau/pull/99)
  [`2bab28b`](https://github.com/sQVe/tau/commit/2bab28b942315b1518701804fea2116893c9c696) Thanks
  [@sQVe](https://github.com/sQVe)! - Record Pi worker activity, selected model, and task-local
  usage without polling transcripts. Workers can publish short phase descriptions with
  `subagent_progress`. These updates do not wake the parent or extend the task deadline.

- [#223](https://github.com/sQVe/tau/pull/223)
  [`236a9dc`](https://github.com/sQVe/tau/commit/236a9dce9de239c880cd3ae0d1081dc942f2b836) Thanks
  [@sQVe](https://github.com/sQVe)! - Set worker models in `~/.pi/agent/tau.json` with `profiles`,
  such as `{"profiles": {"scout": {"model": "openai-codex/gpt-6.1-sol"}}}`. `profiles.default`
  applies to every profile without its own entry. A launch `model` overrides both. A repository
  `.pi/tau.json` that sets `profiles` is an error.

  Profile files no longer accept `model:`. A profile file that sets it stops loading until you move
  the model into `tau.json`. `TAU_SUBAGENT_MODEL` is removed.

  The `subagent` tool description now lists the models the manager may pass and each profile's
  default.

- [#153](https://github.com/sQVe/tau/pull/153)
  [`df01771`](https://github.com/sQVe/tau/commit/df01771abde19b9fda6d50b4263e5cab51ac31fe) Thanks
  [@sQVe](https://github.com/sQVe)! - Show at most one worker beside each parent. Editing workers
  default to the foreground and investigation workers to the background worker tab. Further
  foreground requests run in the background, and the launch result reports where each worker runs
  and why.

- [#155](https://github.com/sQVe/tau/pull/155)
  [`c857d9b`](https://github.com/sQVe/tau/commit/c857d9bd19efb3501fbfd9830f2c41292e5281c8) Thanks
  [@sQVe](https://github.com/sQVe)! - Load workflow instructions for how agents carry out a task,
  apart from the coding and writing instructions. They tell agents to keep check output instead of
  rerunning checks, never discard uncommitted changes they did not make, and run commands that never
  wait for input. Duplicated rules in the coding and writing instructions are trimmed.

- [#112](https://github.com/sQVe/tau/pull/112)
  [`97e45a7`](https://github.com/sQVe/tau/commit/97e45a7fe2acbd3e15cd803969d4f1c5ad03fa5b) Thanks
  [@sQVe](https://github.com/sQVe)! - Add a `worktree` skill that creates or opens a Grove worktree
  in Herdr for a ticket or task, and an `update-branch` skill that rebases onto the base branch,
  resolves conflicts, and pushes with a lease only when asked to update the PR. `/bro <topic>` now
  explains that topic in plain language instead of restating the last response.

### Patch Changes

- [#120](https://github.com/sQVe/tau/pull/120)
  [`f6bc3ad`](https://github.com/sQVe/tau/commit/f6bc3ade116bb800aa8ade9c4a052618de7f9c34) Thanks
  [@sQVe](https://github.com/sQVe)! - Mark every Proposed ADR as Accepted. All of them are
  implemented, including ADR 0043 after its six cuts.

- [#58](https://github.com/sQVe/tau/pull/58)
  [`ced5e46`](https://github.com/sQVe/tau/commit/ced5e46938781f085ac0efcbf0ff34823a6cac44) Thanks
  [@sQVe](https://github.com/sQVe)! - Recommend full-suite verification after every fresh focused
  pass, including regression checks and session handoffs without observed RED. Keep stale and
  unknown input warnings first. Missing-RED edit reminders remain advisory; there is no need to
  recreate RED after implementation.

- [#77](https://github.com/sQVe/tau/pull/77)
  [`76a04c0`](https://github.com/sQVe/tau/commit/76a04c061c86a41e54844cc078eddd03e593eb83) Thanks
  [@sQVe](https://github.com/sQVe)! - Deliver root worker notices to an active parent at the next
  steering point instead of after its final answer. An idle parent still starts a turn, and question
  notices keep steering.

- [#76](https://github.com/sQVe/tau/pull/76)
  [`b9ef216`](https://github.com/sQVe/tau/commit/b9ef216f1a89340532a1a11a63d62ea949ff7c85) Thanks
  [@sQVe](https://github.com/sQVe)! - Make comment review policy findings advisory. Only inaccurate
  comments block a commit, unless the verifier rejects them.

- [#57](https://github.com/sQVe/tau/pull/57)
  [`fc321ce`](https://github.com/sQVe/tau/commit/fc321ce27a7f08df9618c0b2cba20fdb653a00f7) Thanks
  [@sQVe](https://github.com/sQVe)! - Tighten triage, pane reading, verification, and interview
  snippets to clarify scope, sources, and approval. Add "Check the agreed plan" to compare ticket
  requirements with the implementation and recent decisions before proposing work.

- [#133](https://github.com/sQVe/tau/pull/133)
  [`1504fbc`](https://github.com/sQVe/tau/commit/1504fbca805aa71c27ad1832966c858736d3ae15) Thanks
  [@sQVe](https://github.com/sQVe)! - Keep agents from working in a bare repository root. The system
  prompt points them to the worktree and handoff skills, and `write`, `edit`, `subagent`, and
  `subagent_follow_up` are refused there.

- [#145](https://github.com/sQVe/tau/pull/145)
  [`b083501`](https://github.com/sQVe/tau/commit/b08350178d7e7be177b04a5e954c04a63109a392) Thanks
  [@sQVe](https://github.com/sQVe)! - Stop refusing tools in a bare repository root. The system
  prompt rule remains and now allows writing handoff messages under `.tau/handoffs`, so a manager in
  the root can hand off work.

- [#67](https://github.com/sQVe/tau/pull/67)
  [`00e4b2e`](https://github.com/sQVe/tau/commit/00e4b2e9823356d161f8815a6dbad2b3f322d61e) Thanks
  [@sQVe](https://github.com/sQVe)! - Review large commits in several bounded comment review calls
  instead of rejecting them, and drop the 300-file limit. Commits that change submodules or delete
  files no longer fail review.

- [#254](https://github.com/sQVe/tau/pull/254)
  [`0938b05`](https://github.com/sQVe/tau/commit/0938b05473b1d8c1c5a9ee88bba718061d0d144f) Thanks
  [@sQVe](https://github.com/sQVe)! - `bro` now asks what to explain when there is no earlier
  response. `diagram` asks when the topic is unclear, stops when it cannot read the code, names Pi's
  label widths, and offers the nearest supported type instead of drawing an unsupported one.

- [#43](https://github.com/sQVe/tau/pull/43)
  [`e3c093f`](https://github.com/sQVe/tau/commit/e3c093f327c775bf919bb55277b19eed1e53032a) Thanks
  [@sQVe](https://github.com/sQVe)! - Reject bulk-read requests above the model's context-based
  limit, which reserves the output allowance and ignores skipped binary files, before calling the
  provider, while keeping read trimming enabled. Explicitly allow one retry for bulk-read requests
  and disable prompt-cache retention where the provider supports it.

- [#254](https://github.com/sQVe/tau/pull/254)
  [`0938b05`](https://github.com/sQVe/tau/commit/0938b05473b1d8c1c5a9ee88bba718061d0d144f) Thanks
  [@sQVe](https://github.com/sQVe)! - Make the `bro` and `diagram` skills clearer and shorter.

- [#71](https://github.com/sQVe/tau/pull/71)
  [`8b2f55c`](https://github.com/sQVe/tau/commit/8b2f55c431788bb9866d230e9f31e3d6d47362fa) Thanks
  [@sQVe](https://github.com/sQVe)! - Clarify coding instructions for helper reuse, error reporting,
  and intermediate variables. Replace vague wording and make the naming example follow the rule
  against abbreviations. Treat size thresholds as review guidance and keep related control flow
  together when a split would make it harder to trace.

- [#34](https://github.com/sQVe/tau/pull/34)
  [`36bdff4`](https://github.com/sQVe/tau/commit/36bdff4a20b694ac3568efbd007c8bb8bed29bbd) Thanks
  [@sQVe](https://github.com/sQVe)! - Simplify commit guidance while preserving grouping, approval,
  and retry safeguards. Stop on pending recovery before interpreting a clean working tree as
  success.

- [#257](https://github.com/sQVe/tau/pull/257)
  [`e3016b9`](https://github.com/sQVe/tau/commit/e3016b9b463d0c932e321124927222bc1e5b8f19) Thanks
  [@sQVe](https://github.com/sQVe)! - Make the handoff, worktree, and commit skills clearer and
  shorter. The handoff skill now reads the manager pane and asks the user when the manager pane is
  not at its shell prompt. After a stalled send, it reads the receiver once and never sends again.
  If the message did not show, it reports uncertain delivery and stops. It reports any other send
  error and stops. The commit skill unstages only staging that the agent or the user created.

- [#255](https://github.com/sQVe/tau/pull/255)
  [`dc972b7`](https://github.com/sQVe/tau/commit/dc972b7fb8b4c4bcf0dded641c1b6ed1d59e6429) Thanks
  [@sQVe](https://github.com/sQVe)! - Make the slice, start-slice, and tracker skills clearer and
  shorter. After a container or one-slice ticket create shows no identifier, the slice skill now
  searches the team before a retry, and saves a container it finds. The start-slice skill now adds a
  `start.md` row for an existing agent ticket that has none and fits the agent team route.

- [#258](https://github.com/sQVe/tau/pull/258)
  [`7834b1b`](https://github.com/sQVe/tau/commit/7834b1b5011014d843d228670eaf3bcdc1a753ef) Thanks
  [@sQVe](https://github.com/sQVe)! - Make the pr-feedback, update-branch, and stack skills clearer
  and shorter. pr-feedback now skips the rebase only when `mergeable` stays `UNKNOWN`, and reports a
  failing check's cause only when known. update-branch asks for an unclear target and notes the
  remote tip when it resumes a rebase, so the push has a lease. stack fetches before the
  remote-history check that runs before sync. That check now compares against the tip from before
  the first rebase since the branch's last push, and lets a branch that is only behind its remote
  fast-forward instead of stopping.

- [#256](https://github.com/sQVe/tau/pull/256)
  [`111b542`](https://github.com/sQVe/tau/commit/111b542bb16a28d5647b8dbec179a63a706b7423) Thanks
  [@sQVe](https://github.com/sQVe)! - Make the code-review, triage-findings, and tdd skills clearer.
  The code-review freshness check now applies only the exit-status and error-file checks from the
  capture step. An empty recheck no longer stops the review; a failed check reports freshness as
  unknown.

- [#36](https://github.com/sQVe/tau/pull/36)
  [`1a7a27c`](https://github.com/sQVe/tau/commit/1a7a27cec9946a0a9e3edf8bb5c9e0d0037452cd) Thanks
  [@sQVe](https://github.com/sQVe)! - Clarify interview questions and continue until the work is
  clear. Broaden pane reading to anything the other panes hold about the task, and rename that
  snippet to "Read other panes". Rename the review snippet to "Investigate, don't change", and give
  triage results a fixed format.

- [#47](https://github.com/sQVe/tau/pull/47)
  [`fe6a892`](https://github.com/sQVe/tau/commit/fe6a892e87612b9382f009e1c7a1cd133c4b57da) Thanks
  [@sQVe](https://github.com/sQVe)! - Clarify writing rules for user steps, interrupted work,
  requests for input, and failure reports. Use action-first procedural instructions and explain
  unfamiliar technical terms briefly.

- [#205](https://github.com/sQVe/tau/pull/205)
  [`c31d147`](https://github.com/sQVe/tau/commit/c31d14783d3f02fdda456d6913041169aaf667d7) Thanks
  [@sQVe](https://github.com/sQVe)! - Add four coding rules: question whether a change needs to
  exist, prefer deleting code, use the standard library or installed dependencies before adding one,
  and fix bugs at the shared root cause.

- [#48](https://github.com/sQVe/tau/pull/48)
  [`c315245`](https://github.com/sQVe/tau/commit/c31524583905da803fb5f83fece6e28aadb3e917) Thanks
  [@sQVe](https://github.com/sQVe)! - Stop before restaging when preparation leaves changed output
  only in its private index. Retain that output under a recovery ref for inspection, including
  staged-only deletions and output from failed or cancelled preparation. Reject failed message
  checks before comment review, and report reviewer failures separately from comment findings.
  Remove the unused preparationAddedFiles result field.

- [#26](https://github.com/sQVe/tau/pull/26)
  [`6917c97`](https://github.com/sQVe/tau/commit/6917c97c58cc15cfb68f34ab2ed87b014fc30819) Thanks
  [@sQVe](https://github.com/sQVe)! - Return cancellation when a commit's project check is aborted.
  Use a junction to share candidate dependencies on Windows, and preserve tracked `node_modules`
  content in the candidate checkout.

  Guard relative writes from a symlinked working directory against its canonical path. Discover
  `nodejs` on PATH when Pi runs as a compiled executable. Clarify that TDD behavior labels may
  change while test names and files stay fixed through the cycle.

- [#236](https://github.com/sQVe/tau/pull/236)
  [`5821baa`](https://github.com/sQVe/tau/commit/5821baafbc7273932b166bd46d37bf973d06c27e) Thanks
  [@sQVe](https://github.com/sQVe)! - Keep pull request bodies from the `pr` skill short: state the
  change, say why it is needed and what the diff cannot show, and leave out what the diff or commit
  messages already show.

- [#82](https://github.com/sQVe/tau/pull/82)
  [`dd8e9f7`](https://github.com/sQVe/tau/commit/dd8e9f74423c36dcf368547d654459fe1c138d0e) Thanks
  [@sQVe](https://github.com/sQVe)! - Allow a conditional spread for optional object properties in
  the coding instructions, and build lists with optional items in steps.

- [#89](https://github.com/sQVe/tau/pull/89)
  [`53bfe06`](https://github.com/sQVe/tau/commit/53bfe06eea8db38bbd73d57aee3225cec6d7b814) Thanks
  [@sQVe](https://github.com/sQVe)! - Explain cross-worktree refusals. Subagent launches outside the
  session cwd point to the agent already running there. Commit paths outside the session cwd, and
  commits from a folder that is not a Git work tree, say to commit from a session in the owning
  worktree. When Vitest lookup fails, `run_tests` says tests run from the session cwd and names the
  package root of requested files that lie outside it.

- [#85](https://github.com/sQVe/tau/pull/85)
  [`78f42c4`](https://github.com/sQVe/tau/commit/78f42c49cd2df789b0c0d182be869538fe97f13a) Thanks
  [@sQVe](https://github.com/sQVe)! - Worker contracts define success, failure, and incomplete, and
  say that remaining steps are not a blocker. Named tests, docs, and checks count as assigned work.
  The missing-report reminder no longer tells a worker to stop starting work.

- [#37](https://github.com/sQVe/tau/pull/37)
  [`3ce3826`](https://github.com/sQVe/tau/commit/3ce3826a8830d3710b5f521e6b57c4c40fffa04f) Thanks
  [@sQVe](https://github.com/sQVe)! - Keep documents focused on their reader and question. Follow
  repository guidance for each document type instead of creating documents just because code
  changed.

- [#81](https://github.com/sQVe/tau/pull/81)
  [`6b29208`](https://github.com/sQVe/tau/commit/6b29208c8570b062155c0f2ea20c53f7ce6bf09c) Thanks
  [@sQVe](https://github.com/sQVe)! - Refuse new worker launches while shutdown cleanup runs.
  Recover pending generic worker starts within the cleanup budget before stopping them, and retain
  capacity when ownership cannot be verified.

- [#147](https://github.com/sQVe/tau/pull/147)
  [`9387b36`](https://github.com/sQVe/tau/commit/9387b36743b2ea13ef2b56ddd4996e507decdcab) Thanks
  [@sQVe](https://github.com/sQVe)! - Tell agents to drop backwards compatibility by default: update
  the callers and delete the old path. Ask first when a published package, API, or CLI, a user-owned
  config file, or saved data may depend on the old surface.

- [#78](https://github.com/sQVe/tau/pull/78)
  [`48ce67d`](https://github.com/sQVe/tau/commit/48ce67dff4a7ea0dafd5c2d39148e57008d13c89) Thanks
  [@sQVe](https://github.com/sQVe)! - Fix Pi worker startup when multiple CC Safety Net
  installations register the same command. Keep every configured integration and require the saved
  safety extension's exact source path.

- [#58](https://github.com/sQVe/tau/pull/58)
  [`ced5e46`](https://github.com/sQVe/tau/commit/ced5e46938781f085ac0efcbf0ff34823a6cac44) Thanks
  [@sQVe](https://github.com/sQVe)! - Show new edit/write TDD hints as nonblocking info
  notifications in Pi UI sessions. Keep the hint in agent-visible result text. Existing
  deduplication still prevents repeated notices, and headless sessions do not notify.

- [#81](https://github.com/sQVe/tau/pull/81)
  [`6b29208`](https://github.com/sQVe/tau/commit/6b29208c8570b062155c0f2ea20c53f7ce6bf09c) Thanks
  [@sQVe](https://github.com/sQVe)! - Reject empty and whitespace-only worker bash commands before
  Safety Net. Ask the worker to correct the command and continue. Real commands still pass unchanged
  to Safety Net.

- [#141](https://github.com/sQVe/tau/pull/141)
  [`ea42849`](https://github.com/sQVe/tau/commit/ea428491b58137d318be16d3d3b2f932c7772610) Thanks
  [@sQVe](https://github.com/sQVe)! - Block only `git commit` commands the shell would run. Text in
  quoted arguments, comments, and heredoc bodies no longer triggers the bash commit guard, so
  `gh pr create --body` text and scripts that mention `git commit` pass. Chains, pipelines,
  subshells, substitutions, command prefixes, and text passed to a shell such as `sh -c` or `| bash`
  still block. Commands that do not parse fall back to the previous stricter match.

- [#60](https://github.com/sQVe/tau/pull/60)
  [`bbb1155`](https://github.com/sQVe/tau/commit/bbb1155c04269b752f25eea5554e9aca35376336) Thanks
  [@sQVe](https://github.com/sQVe)! - Make `/commit` send the commit skill's instructions to the
  model. It used to send the bare `/skill:commit` text.

- [#4](https://github.com/sQVe/tau/pull/4)
  [`abf7b91`](https://github.com/sQVe/tau/commit/abf7b91dc7f3adab53adb92e3ece6af8ab8e1ae1) Thanks
  [@sQVe](https://github.com/sQVe)! - Fix the Changesets release flow so merging the release PR
  creates a tagged GitHub Release for the private package.

- [#5](https://github.com/sQVe/tau/pull/5)
  [`16ab38d`](https://github.com/sQVe/tau/commit/16ab38d1cc0d19cf92614af7e3f1057a1e9ac40b) Thanks
  [@sQVe](https://github.com/sQVe)! - Improve commit failure diagnostics by including trimmed hook
  output in `CommitFailedError` messages, and add coverage for the whitespace-only stderr fallback
  case.

- [#31](https://github.com/sQVe/tau/pull/31)
  [`0e73867`](https://github.com/sQVe/tau/commit/0e7386752f3290316a9f2b83e4d7607f5e5f7edf) Thanks
  [@sQVe](https://github.com/sQVe)! - Cut the test suite's wall-clock time by supplying the TDD
  observation tests with runner reports instead of spawning a real Vitest process for every step,
  and by dropping a case that waited out the full runner timeout.

- [#243](https://github.com/sQVe/tau/pull/243)
  [`6778868`](https://github.com/sQVe/tau/commit/67788683047a76cb09535574cdbcc4fd138ccbbb) Thanks
  [@sQVe](https://github.com/sQVe)! - Ship skills and instruction sets from `src/`, and load Tau
  from `src/tau.ts`. A follow-up to a worker started before this update fails with "Saved worker
  skill is missing" when its profile names a bundled skill. Start a new worker instead.

- [#217](https://github.com/sQVe/tau/pull/217)
  [`043b4b4`](https://github.com/sQVe/tau/commit/043b4b4ada7f13d44da8342a87e52f2883587369) Thanks
  [@sQVe](https://github.com/sQVe)! - The workflow instructions tell a manager to start a new
  session when a batch of work has finished and no workers are running, and to carry state through
  handoff files and Linear.

- [#71](https://github.com/sQVe/tau/pull/71)
  [`8b2f55c`](https://github.com/sQVe/tau/commit/8b2f55c431788bb9866d230e9f31e3d6d47362fa) Thanks
  [@sQVe](https://github.com/sQVe)! - Restore cancellation of generic workers before their optional
  native session reference appears. Cancellation still checks the worker's process, shell, and
  terminal identity before sending input.

- [#134](https://github.com/sQVe/tau/pull/134)
  [`d773fca`](https://github.com/sQVe/tau/commit/d773fca7f278942b3f493c3c1f13ead595575915) Thanks
  [@sQVe](https://github.com/sQVe)! - Start Pi in the target workspace's manager pane when a handoff
  finds no agent there, instead of asking the user. The handoff skill still asks when several agents
  match, or when the workspace's first tab has several panes or none.

- [#169](https://github.com/sQVe/tau/pull/169)
  [`a51923f`](https://github.com/sQVe/tau/commit/a51923f128086f47c80a14fc170a861e03e0e42d) Thanks
  [@sQVe](https://github.com/sQVe)! - Show a Pi pane as blocked in Herdr while Pi waits on a prompt,
  such as `ask_user_question` or a confirmation. Herdr's Pi integration labels the pane with the
  prompt title.

- [#74](https://github.com/sQVe/tau/pull/74)
  [`3ee3d7a`](https://github.com/sQVe/tau/commit/3ee3d7a70d82ff56ff92ca0ca851c3c3db91ceed) Thanks
  [@sQVe](https://github.com/sQVe)! - Refuse Pi worker launch and follow-up before any herdr pane
  command when the parent's loaded extensions omit herdr's Pi integration. The error names the cause
  and `herdr integration install pi`. When herdr reports a started Pi worker without an
  `agent_session`, the failure detail names herdr's Pi integration instead of a generic identity
  error. Generic workers do not need the integration.

- [#242](https://github.com/sQVe/tau/pull/242)
  [`4043bea`](https://github.com/sQVe/tau/commit/4043bea9166fd6b9dd01c87ff824d559ca5a8605) Thanks
  [@sQVe](https://github.com/sQVe)! - The workflow instructions tell agents that IDs like `wMJ` and
  `wMJ:p1` name herdr workspaces and panes. Agents resolve the workspace with `herdr workspace get`
  before they search files, branches, worktrees, or Linear.

- [#252](https://github.com/sQVe/tau/pull/252)
  [`d4adf26`](https://github.com/sQVe/tau/commit/d4adf26f9bced3dfe65b756ff9836da03f02a4e7) Thanks
  [@sQVe](https://github.com/sQVe)! - Make `#interview` keep asking questions until it understands
  what you want, then summarize and wait.

- [#87](https://github.com/sQVe/tau/pull/87)
  [`6fa1b72`](https://github.com/sQVe/tau/commit/6fa1b721e7ea0bb090322d0a8665e1c85552516c) Thanks
  [@sQVe](https://github.com/sQVe)! - Keep the original error when cleanup or reporting also fails.
  Commit reports the group error with the cleanup error, reply results name why delivery is
  uncertain, and an unreadable parent or saved task is reported as unreadable instead of cancelled
  or unnamed.

- [#166](https://github.com/sQVe/tau/pull/166)
  [`c502629`](https://github.com/sQVe/tau/commit/c502629e8baea8ce56f9e752cb651d907b9c326c) Thanks
  [@sQVe](https://github.com/sQVe)! - Keep a worker's name in its tab label until its stop is
  confirmed. A worker whose cleanup ends unconfirmed may still run, so its name stays. Its terminal
  is still released for placement.

- [#81](https://github.com/sQVe/tau/pull/81)
  [`6b29208`](https://github.com/sQVe/tau/commit/6b29208c8570b062155c0f2ea20c53f7ce6bf09c) Thanks
  [@sQVe](https://github.com/sQVe)! - Include the parent session shutdown reason in worker cleanup
  records. Keep reload cleanup inside the original cancellation budget.

- [#58](https://github.com/sQVe/tau/pull/58)
  [`ced5e46`](https://github.com/sQVe/tau/commit/ced5e46938781f085ac0efcbf0ff34823a6cac44) Thanks
  [@sQVe](https://github.com/sQVe)! - Track JS/TS changes under apps, packages, functions, and infra
  as well as src when checking test freshness and suggesting edit hints. Include nested package,
  Vite/Vitest, TypeScript, lockfile, and pnpm/Vitest workspace configuration. Exclude dependency and
  common generated directories from both checks. Runner outcomes remain separate from freshness.

- [#99](https://github.com/sQVe/tau/pull/99)
  [`2bab28b`](https://github.com/sQVe/tau/commit/2bab28b942315b1518701804fea2116893c9c696) Thanks
  [@sQVe](https://github.com/sQVe)! - Sanitize task-derived widget labels, paste the chosen worker
  name after the history view closes, and keep cosmetic pane-title updates from delaying task
  dispatch.

- [#178](https://github.com/sQVe/tau/pull/178)
  [`bb85f2e`](https://github.com/sQVe/tau/commit/bb85f2e51004005bc396f7cc60b7fb2a56ef5242) Thanks
  [@sQVe](https://github.com/sQVe)! - Workers get their profile and handoff rules in the system
  prompt instead of the first message, so follow-ups do not resend them and compaction keeps them.
  The first message holds only the task and its deadline. Worker prompts drop lines that tool
  descriptions already state, and the `qa` profile now keeps its report under about 4,000 characters
  like `scout` and `reviewer`.

- [#224](https://github.com/sQVe/tau/pull/224)
  [`2a9302d`](https://github.com/sQVe/tau/commit/2a9302d441b862e27cae70bbe9ecd5a6a4503284) Thanks
  [@sQVe](https://github.com/sQVe)! - Tell the manager to act on a worker report without waiting for
  the user. It sends in-scope reviewer findings on a delegated change back to the worker, unless a
  skill it follows requires approval first. After any report, it starts the next step it owns. It
  asks only when that step needs a decision it cannot make, and it reports and stops when the work
  is done.

- [#163](https://github.com/sQVe/tau/pull/163)
  [`5e2f10c`](https://github.com/sQVe/tau/commit/5e2f10c198a9bc74ae78b24db059137e3832b865) Thanks
  [@sQVe](https://github.com/sQVe)! - Tell managers to make small edits themselves, including the
  small fix in a task they otherwise delegate.

- [#157](https://github.com/sQVe/tau/pull/157)
  [`d35f076`](https://github.com/sQVe/tau/commit/d35f076872f68cc8e55814cad25195f3a9c56d56) Thanks
  [@sQVe](https://github.com/sQVe)! - Title worker panes with the name and model only, such as
  `scout-as (claude-opus-5-5)`. A worker without a known model shows just its name.

- [#38](https://github.com/sQVe/tau/pull/38)
  [`9096f38`](https://github.com/sQVe/tau/commit/9096f381636ec137d739333c392762f7b5c80138) Thanks
  [@sQVe](https://github.com/sQVe)! - Limit bulk-read guidance to summaries, test inventories, and
  locating evidence in supplied files. Add guidance for checking consequential claims before edits
  or reports. This includes caller searches for integration claims and the actual diff and project
  rules for branch judgments.

- [#146](https://github.com/sQVe/tau/pull/146)
  [`9dc680b`](https://github.com/sQVe/tau/commit/9dc680b8770d0e3e64550da9179aa88d50f6b227) Thanks
  [@sQVe](https://github.com/sQVe)! - Keep follow-ups working when another Tau version saves worker
  records this one cannot read. Saved worker names accept any profile prefix. An unreadable record
  blocks a follow-up only when its predecessor is unreadable or names the same source task.

- [#165](https://github.com/sQVe/tau/pull/165)
  [`512df2d`](https://github.com/sQVe/tau/commit/512df2db3b6a3001b806a39ec716f6bdeaf6300c) Thanks
  [@sQVe](https://github.com/sQVe)! - Default the coding instructions to no comment. Ban comments
  that cite ADRs, tickets, PRs, or reviews, restate the signature below them, or state unchecked
  causes and measurements. Remove the ADR citations from code comments.

- [#73](https://github.com/sQVe/tau/pull/73)
  [`d644b9e`](https://github.com/sQVe/tau/commit/d644b9e2efc73417b4cefdb0d4cddb36d8241c0e) Thanks
  [@sQVe](https://github.com/sQVe)! - Number the source lines sent to commit comment review, so
  findings cite the line the reviewer sees. Line bounds still use the original source line count.

- [#77](https://github.com/sQVe/tau/pull/77)
  [`76a04c0`](https://github.com/sQVe/tau/commit/76a04c061c86a41e54844cc078eddd03e593eb83) Thanks
  [@sQVe](https://github.com/sQVe)! - Notify the parent once per unresolved generic
  observation-error episode instead of on every changed diagnostic. The latest error stays visible
  in status, and a successful inspection lets the next genuine failure notify again.

- [#91](https://github.com/sQVe/tau/pull/91)
  [`377c0bf`](https://github.com/sQVe/tau/commit/377c0bf7c27ceb643ee19aa86a69e67e85c5607a) Thanks
  [@sQVe](https://github.com/sQVe)! - Run one footer git status at a time. A burst of tool results
  now starts at most one more run.

- [#142](https://github.com/sQVe/tau/pull/142)
  [`e31e931`](https://github.com/sQVe/tau/commit/e31e93126e426d48de3eb977769c10f47a4ef0d7) Thanks
  [@sQVe](https://github.com/sQVe)! - Show the full model ID after the provider in worker pane
  titles, such as `meta-llama` instead of `llama` for `openrouter/meta/llama`. Task IDs and model
  references otherwise accept exactly what they did before.

- [#9](https://github.com/sQVe/tau/pull/9)
  [`1a8a14a`](https://github.com/sQVe/tau/commit/1a8a14a0a98bfa98117a8a193923903dda51e351) Thanks
  [@sQVe](https://github.com/sQVe)! - Add integration coverage for the commit flow against a real Pi
  `AgentSession`, driven by the faux provider from `@earendil-works/pi-ai`, and record the testing
  strategy in ADR 0005.

- [#151](https://github.com/sQVe/tau/pull/151)
  [`42b4560`](https://github.com/sQVe/tau/commit/42b4560eb6c1ff3664303695af5b994769926b74) Thanks
  [@sQVe](https://github.com/sQVe)! - Say in the `subagent_reply` description that a Pi reply needs
  the `questionId` from the worker's question notice, and that a Pi worker without a pending
  question takes no reply, so the parent should use `subagent_follow_up` after the worker stops.

- [#81](https://github.com/sQVe/tau/pull/81)
  [`6b29208`](https://github.com/sQVe/tau/commit/6b29208c8570b062155c0f2ea20c53f7ce6bf09c) Thanks
  [@sQVe](https://github.com/sQVe)! - Confirm cleanup after rejected Pi starts and stop
  identity-checked Pi workers when the start response fails or is cancelled.

- [#245](https://github.com/sQVe/tau/pull/245)
  [`86b6708`](https://github.com/sQVe/tau/commit/86b6708d76447e82d9401c9c4429a610f6b59183) Thanks
  [@sQVe](https://github.com/sQVe)! - Check that a plan is ready before an implementation handoff or
  a worktree for one. The handoff skill defines ready: the goal, the scope and what it excludes, the
  acceptance criteria, and every choice that changes the result are in the ticket or approved by the
  user, and its blockers are merged. When something is open, the sender asks its user and sends
  nothing, unless the user asks for a planning-only handoff that lists the open questions. Each
  implementation handoff carries a plan status of "agreed, nothing open", and the receiver asks its
  user before editing if the ticket conflicts with the message. The worktree skill creates a
  worktree only when the user asks for one.

- [#181](https://github.com/sQVe/tau/pull/181)
  [`4eec209`](https://github.com/sQVe/tau/commit/4eec2091a910111b418bec9dd208603b1f441085) Thanks
  [@sQVe](https://github.com/sQVe)! - Make the pr skill ask every question with `ask_user_question`,
  move an update's body to the template when it does not follow it, keep scratch files out of
  `/tmp`, save real check output after the task's changes are committed, and ignore GitHub's dropped
  trailing newlines when it verifies the body. Areas a reviewer read shallowly no longer force a
  draft, and when the review is the only gap the skill asks once, before the preview, whether to
  accept approved fixes, review again, or open as draft. Code review reports shallow reads as notes
  apart from gaps. The body leaves reviewer notes to the summary, and bot suggestions include bots
  the repository configures.

- [#253](https://github.com/sQVe/tau/pull/253)
  [`b32b9e9`](https://github.com/sQVe/tau/commit/b32b9e931dcb58d34efd2976cea53f2b30e06431) Thanks
  [@sQVe](https://github.com/sQVe)! - The `pr` skill puts the review result, checks, untested areas,
  and known gaps in the template's verification section instead of the summary. The fallback
  template adds "Untested" and "Open finding" lines. The `ask_user_question` tool now tells every
  agent to state the blocked decision and stop when the user closes the dialog without an answer.

- [#79](https://github.com/sQVe/tau/pull/79)
  [`29e019a`](https://github.com/sQVe/tau/commit/29e019a03e40062fd13444ca7d3c2ac0f8bd2909) Thanks
  [@sQVe](https://github.com/sQVe)! - Explain that foreground workers split the parent pane or one
  of its worker panes and preserve focus, manual split ratios, and unrelated panes. Parents choose
  foreground for work the user benefits from watching and background for the rest.

- [#129](https://github.com/sQVe/tau/pull/129)
  [`93a8877`](https://github.com/sQVe/tau/commit/93a8877e593336f1368ecd7b4418e38e0a11fd8d) Thanks
  [@sQVe](https://github.com/sQVe)! - The first foreground worker opens beside the parent on
  laptop-sized terminals, such as 193 columns by 60 rows, instead of stacking below it. Later
  workers are placed as before.

- [#140](https://github.com/sQVe/tau/pull/140)
  [`9cd7559`](https://github.com/sQVe/tau/commit/9cd75599ef8165c1361e2c3ef5e3ccbe8e454aaf) Thanks
  [@sQVe](https://github.com/sQVe)! - Name subagent panes after their profile when it is named
  `worker`, `scout`, or `reviewer`, so reviewers show as `reviewer-*` instead of `scout-*`. This
  includes user or project profiles that override one of those names. Other custom profiles keep the
  role prefix. Saved `scout-*` and `investigator-*` workers stay readable.

- [#39](https://github.com/sQVe/tau/pull/39)
  [`fb860de`](https://github.com/sQVe/tau/commit/fb860dec9df2dda7ad7fa4fb0c1a3d74558101fa) Thanks
  [@sQVe](https://github.com/sQVe)! - Remove commit recovery snapshots and their Git ref after
  verified restoration, keeping only the displaced inodes. Treat checker output matched by the
  external exclude rules that were in force at backup time as ignored, so `.git/info/exclude` and
  `core.excludesFile` artifacts no longer strand working edits.

- [#156](https://github.com/sQVe/tau/pull/156)
  [`8a8c305`](https://github.com/sQVe/tau/commit/8a8c305c621ff78f8f976dd8cb5d89a757635f98) Thanks
  [@sQVe](https://github.com/sQVe)! - Separate reading a worker's records from deciding its state.
  Worker state is unchanged; a test now keeps registered decision modules free of record reads, the
  clock, randomness, and the environment.

- [#148](https://github.com/sQVe/tau/pull/148)
  [`5d3183c`](https://github.com/sQVe/tau/commit/5d3183c32dcca4acf634011406edda6c63dae1f4) Thanks
  [@sQVe](https://github.com/sQVe)! - Add a bundled `qa` subagent profile. It uses a finished change
  in the app the user already runs from the worktree, as a user would in a browser or on the command
  line, and reports what a user would hit: departures from the task or linked spec, regressions,
  errors, and broken or confusing flows, each with repro steps and evidence. It does not edit the
  worktree or install, build, start, or stop anything; when the app is not running from the worktree
  or needs a test account, it asks the manager to check with the user. The manager passes only
  test-account credentials, because worker records keep them. The manager sends changes with
  user-visible behavior to `qa` alongside the reviewer. Browser testing needs the
  `pi-agent-browser-native` package.

  Split the bundled `scout` and `reviewer` instructions into short paragraphs, with a list for the
  reviewer's rerun conditions, without changing their wording.

- [#126](https://github.com/sQVe/tau/pull/126)
  [`e0e6f84`](https://github.com/sQVe/tau/commit/e0e6f84e6c6bf080b701fbe7d7e74375452c32d4) Thanks
  [@sQVe](https://github.com/sQVe)! - Make repository checks pass inside worker panes by isolating
  the test worker environment. Keep controller history tests out of the developer's Pi session
  directory. Allow worker tasks to authorize commits, merges, or resets while still forbidding extra
  model trials.

- [#128](https://github.com/sQVe/tau/pull/128)
  [`3f75087`](https://github.com/sQVe/tau/commit/3f75087ce20d8f693df85795d29357e787395330) Thanks
  [@sQVe](https://github.com/sQVe)! - Fail worker launches promptly after startup exits instead of
  waiting for herdr's timeout. Preserve the worker's failure detail and confirm the shell is bare
  before cleanup.

- [#85](https://github.com/sQVe/tau/pull/85)
  [`78f42c4`](https://github.com/sQVe/tau/commit/78f42c49cd2df789b0c0d182be869538fe97f13a) Thanks
  [@sQVe](https://github.com/sQVe)! - Pi workers must name a blocker to report incomplete. While at
  least a fifth of the task window and five minutes remain, the first incomplete report is refused
  and the worker is told to finish the assigned work. The blocker leads the saved summary.

- [#139](https://github.com/sQVe/tau/pull/139)
  [`073d06f`](https://github.com/sQVe/tau/commit/073d06f96546b06e4c8c9e6eb72643fb3584d83c) Thanks
  [@sQVe](https://github.com/sQVe)! - Refuse a Pi worker report whose summary misses the Changes,
  Evidence, Decisions, or Concerns heading, and name the missing sections so the worker can resend.
  The handoff template now asks for compact bullets and references, with None under empty sections.

- [#44](https://github.com/sQVe/tau/pull/44)
  [`587ef49`](https://github.com/sQVe/tau/commit/587ef494e2afda0f5af4b3e76eb8724cec558ae8) Thanks
  [@sQVe](https://github.com/sQVe)! - Show the remaining line range in clamped read hints. Suggest
  `bulk_read` only when more than 400 lines remain; otherwise, give a bounded read with `offset` and
  `limit`.

- [#235](https://github.com/sQVe/tau/pull/235)
  [`f1d78e7`](https://github.com/sQVe/tau/commit/f1d78e7b2a86922889a9ffa7b9f4e58cce3acf86) Thanks
  [@sQVe](https://github.com/sQVe)! - Report background worker failures instead of dropping them. A
  failed stop, such as a failed timeout notice, now appears in the worker's status. A failure to
  reattach saved workers at session start now shows an error in the UI.

- [#137](https://github.com/sQVe/tau/pull/137)
  [`9e3ff2e`](https://github.com/sQVe/tau/commit/9e3ff2e76171cfce4c70d362f4ddaae34f3e3090) Thanks
  [@sQVe](https://github.com/sQVe)! - Report every missing or non-file path in one `bulk_read`
  refusal instead of stopping at the first. Add coding instructions to run commands CC Safety Net
  may block in their own bash call and to append `|| true` only to probes.

- [#207](https://github.com/sQVe/tau/pull/207)
  [`36f9c80`](https://github.com/sQVe/tau/commit/36f9c80a7c365d5c24cea54a92fe31bf4b8ef52c) Thanks
  [@sQVe](https://github.com/sQVe)! - Send a worker's report reminder at Pi's final settle boundary
  instead of at the end of each run, so the reminder does not arrive during a retry or compaction
  and is not sent twice.

- [#81](https://github.com/sQVe/tau/pull/81)
  [`6b29208`](https://github.com/sQVe/tau/commit/6b29208c8570b062155c0f2ea20c53f7ce6bf09c) Thanks
  [@sQVe](https://github.com/sQVe)! - Ask Pi workers once for a missing report before settlement,
  within the original work deadline. Do not prompt reported, cancelled, waiting, or expired workers.

- [#65](https://github.com/sQVe/tau/pull/65)
  [`40efcee`](https://github.com/sQVe/tau/commit/40efceeca3cbd8fc03f0c0fbde17ee801769c79b) Thanks
  [@sQVe](https://github.com/sQVe)! - Restore Pi's cached model catalog when checking worker
  launches, saved replays, and worker startup. This avoids false model mismatches without enabling
  catalog network requests or relaxing model, provider, or safety checks. Preserve the cancellation
  error when catalog restoration is interrupted.

- [#144](https://github.com/sQVe/tau/pull/144)
  [`dcac7c1`](https://github.com/sQVe/tau/commit/dcac7c1ac4ccd0f612c2a5ad97f0758e4662f051) Thanks
  [@sQVe](https://github.com/sQVe)! - Cancelling a worker while the parent is reattaching to it no
  longer starts a second cleanup. The worker stays owned until its one cleanup finishes.

- [#81](https://github.com/sQVe/tau/pull/81)
  [`6b29208`](https://github.com/sQVe/tau/commit/6b29208c8570b062155c0f2ea20c53f7ce6bf09c) Thanks
  [@sQVe](https://github.com/sQVe)! - Keep worker capacity and follow-up claims reserved when final
  absence verification or pane closure fails. Preserve confirmed cleanup if only placement updates
  fail after the pane has closed.

- [#81](https://github.com/sQVe/tau/pull/81)
  [`6b29208`](https://github.com/sQVe/tau/commit/6b29208c8570b062155c0f2ea20c53f7ce6bf09c) Thanks
  [@sQVe](https://github.com/sQVe)! - Close unchanged worker panes after rejected starts. Allow
  follow-up retries after confirmed cleanup before assignment dispatch or acceptance. Wait for Pi's
  session identity before dispatching work.

- [#167](https://github.com/sQVe/tau/pull/167)
  [`5b572cb`](https://github.com/sQVe/tau/commit/5b572cb5d7a89f19bce48891fc31917ef834d55b) Thanks
  [@sQVe](https://github.com/sQVe)! - Tell managers to pass reviewers the worker's check log path
  and a diff hash, and to use one reviewer unless a large or risky change needs two. Shared briefs
  go in a file, cheap models get a shorter timeout, and multi-model discussions default to one round
  with two models. Reviewer and scout reports stay under about 4,000 characters and save longer
  details to a file.

- [#136](https://github.com/sQVe/tau/pull/136)
  [`ba26548`](https://github.com/sQVe/tau/commit/ba265482a4bcc1a999f52d7a135753b532bd4d38) Thanks
  [@sQVe](https://github.com/sQVe)! - Let `run_tests` accept existing test files whose paths contain
  brackets, such as Next.js routes like `app/[teamId]/page.test.tsx`. Globs are still refused. The
  tool description now says up front that it runs Vitest only.

- [#66](https://github.com/sQVe/tau/pull/66)
  [`fac14fb`](https://github.com/sQVe/tau/commit/fac14fbf221f7b6e23e08355f40c92e1d91f7aeb) Thanks
  [@sQVe](https://github.com/sQVe)! - Add three snippets for the end of a session. Score confidence
  rates each part of the session's work and names what would settle each doubt. Blind spots asks for
  the biggest thing you are missing. Simplify looks for a change that cuts complexity without losing
  capability.

- [#81](https://github.com/sQVe/tau/pull/81)
  [`6b29208`](https://github.com/sQVe/tau/commit/6b29208c8570b062155c0f2ea20c53f7ce6bf09c) Thanks
  [@sQVe](https://github.com/sQVe)! - Wait for an in-flight Pi start response within the cleanup
  budget before checking for worker absence. Prevent shutdown from freeing a slot while a late start
  leaves Pi running.

- [#118](https://github.com/sQVe/tau/pull/118)
  [`f9fb019`](https://github.com/sQVe/tau/commit/f9fb019715e807e9bebffda849a5c49279ae7e8c) Thanks
  [@sQVe](https://github.com/sQVe)! - Shorten subagent tool descriptions and clarify the inputs,
  worker states, and reply delivery results.

- [#212](https://github.com/sQVe/tau/pull/212)
  [`a0cb3bc`](https://github.com/sQVe/tau/commit/a0cb3bce8fe80b3d18080970ffc48679711a3797) Thanks
  [@sQVe](https://github.com/sQVe)! - Shorten the descriptions and guidelines of Tau's own tools,
  which every parent and worker sends on each turn. `run_tests` drops from 4,020 to 1,303
  characters, the six parent `subagent` tools from 5,561 to 3,792, the three worker tools from 2,067
  to 1,577, and the `commit` guidelines from 1,488 to 454. Run results, errors, and the `tdd` and
  `commit` skills still give the details that were cut.

- [#143](https://github.com/sQVe/tau/pull/143)
  [`3e4099d`](https://github.com/sQVe/tau/commit/3e4099db1c95e32f408f48c1e39dedb401b1a3d0) Thanks
  [@sQVe](https://github.com/sQVe)! - `subagent_status` no longer stops a worker whose saved
  evidence is unreadable, and launch and follow-up no longer stop a worker whose status is
  unreadable right after launch. Use `subagent_cancel` to stop it. Cancel now works even when the
  saved cleanup record is corrupt, for a worker this session still owns. Reading native output no
  longer refreshes worker identity or saves records.

- [#240](https://github.com/sQVe/tau/pull/240)
  [`3a5f075`](https://github.com/sQVe/tau/commit/3a5f075f8a1379e97ab8f7fe146c5106bdcf4ca5) Thanks
  [@sQVe](https://github.com/sQVe)! - Add a skill authoring guide and template in `docs/`, and a
  test that checks every skill's frontmatter, local links, headings, ADR mentions, and shell blocks.
  The `code-review`, `slice`, and `tdd` skills drop their last ADR mentions and the `Principles`
  heading.

- [#59](https://github.com/sQVe/tau/pull/59)
  [`eea0fbb`](https://github.com/sQVe/tau/commit/eea0fbb2cb5d72b7b608cbbbf2a6e1b5be6e86b6) Thanks
  [@sQVe](https://github.com/sQVe)! - Leave lockfiles such as `pnpm-lock.yaml` and `Cargo.lock` out
  of commit comment review, so large lockfiles no longer block commits. Commits that change only
  lockfiles skip review.

- [#59](https://github.com/sQVe/tau/pull/59)
  [`eea0fbb`](https://github.com/sQVe/tau/commit/eea0fbb2cb5d72b7b608cbbbf2a6e1b5be6e86b6) Thanks
  [@sQVe](https://github.com/sQVe)! - Guide the commit skill to split changes into small, isolated
  groups. Dependencies, prerequisite refactors, and documentation get their own commits.

- [#81](https://github.com/sQVe/tau/pull/81)
  [`6b29208`](https://github.com/sQVe/tau/commit/6b29208c8570b062155c0f2ea20c53f7ce6bf09c) Thanks
  [@sQVe](https://github.com/sQVe)! - Require two stable shell samples before worker startup. Retry
  a structured pane-busy rejection once after confirming absence, within the original deadline.

- [#34](https://github.com/sQVe/tau/pull/34)
  [`36bdff4`](https://github.com/sQVe/tau/commit/36bdff4a20b694ac3568efbd007c8bb8bed29bbd) Thanks
  [@sQVe](https://github.com/sQVe)! - Apply the staged candidate's Git checkout attributes during
  commit checks, including file encoding and line endings. Restore original working bytes and
  staging without conversion.

- [#34](https://github.com/sQVe/tau/pull/34)
  [`36bdff4`](https://github.com/sQVe/tau/commit/36bdff4a20b694ac3568efbd007c8bb8bed29bbd) Thanks
  [@sQVe](https://github.com/sQVe)! - Run staged commit checks in the existing checkout, keeping
  installed workspace dependencies available. Save verified recovery before hiding working edits and
  restore before review or approval. Retain recovery data and block further commits when checker
  writes or interrupted recovery need inspection.

- [#152](https://github.com/sQVe/tau/pull/152)
  [`fab8fc3`](https://github.com/sQVe/tau/commit/fab8fc371fb6f9419f1880fa97aef1a640f32abe) Thanks
  [@sQVe](https://github.com/sQVe)! - Commit an already-staged deletion in its group instead of
  failing at `git add`. A failed group no longer unstages changes that were staged before the call;
  it restores their earlier staging.

- [#127](https://github.com/sQVe/tau/pull/127)
  [`95a851a`](https://github.com/sQVe/tau/commit/95a851a04041eb40d7f5f454dea26616ff4635ef) Thanks
  [@sQVe](https://github.com/sQVe)! - subagent_status now returns the recovery details for
  unreadable worker evidence even when the call names an unknown question.

- [#117](https://github.com/sQVe/tau/pull/117)
  [`d7e4f22`](https://github.com/sQVe/tau/commit/d7e4f2248851d8bab68af469323d0be6e2da9241) Thanks
  [@sQVe](https://github.com/sQVe)! - Worker startup and cleanup no longer fail when a zsh prompt
  hook briefly occupies the shell. herdr now gets a start timeout below Tau's own budget and above
  herdr's 3000 ms minimum, so its structured timeout error reaches the task record. A launch with
  too little budget left is refused before `agent start`, and failures before any start say that no
  worker was started.

- [#124](https://github.com/sQVe/tau/pull/124)
  [`a28e14e`](https://github.com/sQVe/tau/commit/a28e14e0d167dc510fc5d9bd836900f45dbef5bc) Thanks
  [@sQVe](https://github.com/sQVe)! - Stop saved workers whose work budget expires before or during
  reattachment. Record the timeout and cleanup result instead of leaving a running worker without a
  deadline.

- [#81](https://github.com/sQVe/tau/pull/81)
  [`6b29208`](https://github.com/sQVe/tau/commit/6b29208c8570b062155c0f2ea20c53f7ce6bf09c) Thanks
  [@sQVe](https://github.com/sQVe)! - Stop owned workers within their cleanup budgets when the
  parent Pi session shuts down.

- [#40](https://github.com/sQVe/tau/pull/40)
  [`ba86a42`](https://github.com/sQVe/tau/commit/ba86a4227e5a475a42e9b416f5fe7822f20365b1) Thanks
  [@sQVe](https://github.com/sQVe)! - Make project and staged-file lint checks fail on warnings. Fix
  lint diagnostics and add scoped exceptions for test patterns, ordered operations, and
  ownership-sensitive control flow.

- [#52](https://github.com/sQVe/tau/pull/52)
  [`47e7c35`](https://github.com/sQVe/tau/commit/47e7c35a6dc7583a98c5bf25066f9b25e434a625) Thanks
  [@sQVe](https://github.com/sQVe)! - Keep successful Git hook content and message rewrites and
  added paths committed. Report the stored message, committed files, and changes from the reviewed
  tree. Preserve raw hook failures and commit success information when cleanup or reporting fails.

  Limit automatic comment-review returns to two per group. Remaining findings cause a refusal. New
  dispute evidence cannot reopen a refused tree; corrected trees remain reviewable. Stop remaining
  groups when an earlier hook committed their requested changes and no new staged changes remain.

- [#8](https://github.com/sQVe/tau/pull/8)
  [`959b778`](https://github.com/sQVe/tau/commit/959b778b7e45ecfe2c547d0d5032610cdfb526f5) Thanks
  [@sQVe](https://github.com/sQVe)! - Consolidate development tooling, preserve lint rules across
  the Vite+ upgrade, and verify Pi package loading in the test suite. Remove the unused
  workspace-state schema import while keeping its export.

  Update dependencies and enforce type-aware promise and unsafe-value checks.

- [#53](https://github.com/sQVe/tau/pull/53)
  [`10292ef`](https://github.com/sQVe/tau/commit/10292ef68ec8615aadb97f60004035350a0500c9) Thanks
  [@sQVe](https://github.com/sQVe)! - Clarify the unattended commit flow and retries after hook or
  comment review failures. Use the shared Git helper for staging and path queries so interrupted
  commands stop the commit flow. Preserve their lack of a timeout while keeping existing review
  calls bounded.

- [#34](https://github.com/sQVe/tau/pull/34)
  [`36bdff4`](https://github.com/sQVe/tau/commit/36bdff4a20b694ac3568efbd007c8bb8bed29bbd) Thanks
  [@sQVe](https://github.com/sQVe)! - Block commit work while recovery is pending, including
  incomplete recovery data. Add verified raw backup and conservative recovery support without
  changing preparation or candidate checks.

- [#162](https://github.com/sQVe/tau/pull/162)
  [`e9931e1`](https://github.com/sQVe/tau/commit/e9931e17a8bdbaa3d5141cff8a32250644d41672) Thanks
  [@sQVe](https://github.com/sQVe)! - Pi workers now give a `blockerKind` with an incomplete report.
  A `time` blocker is accepted only in the last tenth of the work window and is refused on every
  earlier attempt; other kinds keep the existing early-report rule. Workers now measure remaining
  time on their own clock, so a worker started after its parent no longer sees extra minutes.

- [#73](https://github.com/sQVe/tau/pull/73)
  [`d644b9e`](https://github.com/sQVe/tau/commit/d644b9e2efc73417b4cefdb0d4cddb36d8241c0e) Thanks
  [@sQVe](https://github.com/sQVe)! - Verify each inaccuracy finding from comment review against a
  numbered excerpt of the file before returning it. Findings the verifier does not establish become
  advisory `unverified` findings, so accurate comments no longer consume the two automatic returns.

- [#149](https://github.com/sQVe/tau/pull/149)
  [`b3b7c9e`](https://github.com/sQVe/tau/commit/b3b7c9ef570652413e4c9556bb5f099fb30df7ef) Thanks
  [@sQVe](https://github.com/sQVe)! - Save worker task records with a format version that no longer
  names the worker kind. Tasks saved in the previous format stay readable. A task saved by a newer
  Tau is skipped with a notice to restart the session, and it still blocks a second follow-up of the
  same source.

- [#50](https://github.com/sQVe/tau/pull/50)
  [`01c69b7`](https://github.com/sQVe/tau/commit/01c69b72f4c1d2e24d80fb37a6d6f22904fad6b7) Thanks
  [@sQVe](https://github.com/sQVe)! - Show focused test files and names, or full-suite scope, while
  `run_tests` runs. Include scope, duration, file-level failures, and input freshness in the result.

  Save bounded console output and the raw Vitest report, including successful runs, for inspection
  without rerunning tests. Console output beyond the capture limit no longer stops tests. Report
  truncation accurately and save each diagnostic independently.

  Record the command at the spawn point and save the selection and before/after input fingerprints.
  Show when execution did not start. Store diagnostics in the Pi agent's private `test-runs`
  directory. Cleanup keeps up to 32 completed runs for seven days and protects recent unfinished
  runs. These files are diagnostics, not reusable verification.

  Include test-support code under `tests/` in input fingerprints so helper-only changes invalidate
  freshness without making helpers selectable as tests.

- [#58](https://github.com/sQVe/tau/pull/58)
  [`ced5e46`](https://github.com/sQVe/tau/commit/ced5e46938781f085ac0efcbf0ff34823a6cac44) Thanks
  [@sQVe](https://github.com/sQVe)! - Show test hints before summaries so they remain visible in
  collapsed Pi results, including long failure output.

- [#58](https://github.com/sQVe/tau/pull/58)
  [`ced5e46`](https://github.com/sQVe/tau/commit/ced5e46938781f085ac0efcbf0ff34823a6cac44) Thanks
  [@sQVe](https://github.com/sQVe)! - Support exact nested test names in Vitest 5 using `>`
  surrounded by spaces. Keep space-separated names for Vitest 4. Show version-specific guidance and
  collected names when a focused filter matches nothing, without retrying or broadening selection.

- [#58](https://github.com/sQVe/tau/pull/58)
  [`ced5e46`](https://github.com/sQVe/tau/commit/ced5e46938781f085ac0efcbf0ff34823a6cac44) Thanks
  [@sQVe](https://github.com/sQVe)! - Distinguish unavailable Vitest package lookups from resolver,
  manifest, and binary failures. Keep safe error codes/types and available resolution paths in
  results and saved run records, even when execution never starts. Omit raw error text and manifest
  contents. Suggest inspecting the failure once or using the repository runner; Bash tests do not
  update Tau observations.

- [#111](https://github.com/sQVe/tau/pull/111)
  [`846cb44`](https://github.com/sQVe/tau/commit/846cb44af107487bfeb5a322c1a5b15419dd6da2) Thanks
  [@sQVe](https://github.com/sQVe)! - Stop the parent from sleeping while it waits for a worker. A
  worker notice arrives only after the current tool call finishes, so a long `sleep` held it back.
  The `subagent` tool now tells the parent to end its turn instead. While the session has an active
  worker, bash commands that sleep for 30 seconds or longer are rejected.

- [#81](https://github.com/sQVe/tau/pull/81)
  [`6b29208`](https://github.com/sQVe/tau/commit/6b29208c8570b062155c0f2ea20c53f7ce6bf09c) Thanks
  [@sQVe](https://github.com/sQVe)! - Wait for new worker panes to finish shell startup before
  launching Pi or native workers.

- [#221](https://github.com/sQVe/tau/pull/221)
  [`99dd64a`](https://github.com/sQVe/tau/commit/99dd64a9875b4798b5a4c1fdddc6f0edbb90081b) Thanks
  [@sQVe](https://github.com/sQVe)! - The Triage findings snippet asks what triggers a finding and
  what its fix costs, and allows a smaller fix that covers the concern.

- [#184](https://github.com/sQVe/tau/pull/184)
  [`3b80c2f`](https://github.com/sQVe/tau/commit/3b80c2f128e17a849b645a7b934ed20d1a5ebe18) Thanks
  [@sQVe](https://github.com/sQVe)! - Read worker task history once per widget refresh instead of
  once per row. A 112-row refresh drops from about 1.3 s to under 0.1 s.

- [#99](https://github.com/sQVe/tau/pull/99)
  [`2bab28b`](https://github.com/sQVe/tau/commit/2bab28b942315b1518701804fea2116893c9c696) Thanks
  [@sQVe](https://github.com/sQVe)! - Stop rescanning the reservation tree for each widget history
  row. Widget refreshes read current task records without a cache; the status tool keeps its
  descendant reservation checks.

- [#99](https://github.com/sQVe/tau/pull/99)
  [`2bab28b`](https://github.com/sQVe/tau/commit/2bab28b942315b1518701804fea2116893c9c696) Thanks
  [@sQVe](https://github.com/sQVe)! - Cancel pending streaming activity when newer worker activity
  is recorded. Keep settled activity intact and leave the last snapshot unchanged when Pi has
  disposed its context or usage is unavailable.

- [#208](https://github.com/sQVe/tau/pull/208)
  [`078048e`](https://github.com/sQVe/tau/commit/078048e2a6273688bd2c7b8876618c4ca1aa82e6) Thanks
  [@sQVe](https://github.com/sQVe)! - Cap a worker's successful `bash` output at 8,000 characters.
  The worker's model sees the head, the tail, and a marker with the cut size and the path of a
  private file that holds the full output. Failed commands keep their whole output. Parent sessions
  are unchanged.

- [#248](https://github.com/sQVe/tau/pull/248)
  [`ebadb3f`](https://github.com/sQVe/tau/commit/ebadb3facf68980b8a16daacdd3acf4edbfb8231) Thanks
  [@sQVe](https://github.com/sQVe)! - Tell `worker` subagents to ask the parent with
  `subagent_question` for checks that need a real browser, so the parent can start a `browser` or
  `qa` worker.

- [#202](https://github.com/sQVe/tau/pull/202)
  [`ec7fbfa`](https://github.com/sQVe/tau/commit/ec7fbfae53767f02f6c7cb1604b921ed740ff9bf) Thanks
  [@sQVe](https://github.com/sQVe)! - Accept a worker's time blocker in the last 90 seconds of any
  window, and warn the worker once when that point arrives. When a worker's final turn ends in an
  error or abort, skip the report reminder and show the error as `failure` in the parent's status
  and notice.

- [#99](https://github.com/sQVe/tau/pull/99)
  [`2bab28b`](https://github.com/sQVe/tau/commit/2bab28b942315b1518701804fea2116893c9c696) Thanks
  [@sQVe](https://github.com/sQVe)! - Keep the worker history deadline countdown for live states
  only. Stopped, unconfirmed, untracked, and unknown workers show the deadline as a clock fact
  instead of implying work is still counting down. List and detail navigation accept `home`, `end`,
  and encoded `shift+g` through the shared vim predicates.

- [#164](https://github.com/sQVe/tau/pull/164)
  [`a0764bb`](https://github.com/sQVe/tau/commit/a0764bbc407ee36082bdc9eab57467aafe8f658c) Thanks
  [@sQVe](https://github.com/sQVe)! - Label each worker tab with the names of the workers inside it,
  in launch order, instead of "Tau workers". Past three names, the label counts the rest. The label
  updates as workers join and stop. A failed tab rename never fails a launch or a stop.
