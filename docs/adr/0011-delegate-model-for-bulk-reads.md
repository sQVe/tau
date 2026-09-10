# ADR 0011: Delegate model for bulk reads

- Status: Accepted
- Date: 2026-09-09

## Context

ABU-359 asks whether Tau can reduce the session model's bulk file reading by giving that work to a
cheaper model. Grep and bounded reads answer "where is X" without delegation. Semantic questions
spanning several large files still require a model to read and interpret those files.

The [vision](../vision.md#principles) allows model selection for Tau's tools and subagents to reduce
cost and time, and requires those models to be user-configurable. This proposal applies that
principle to bulk reads.

The ABU-359 investigation confirmed that delegation works with both OAuth and API-key providers.
Model availability varies by provider and account, and valid credentials do not guarantee access to
a particular model. Tau therefore cannot rely on one hardcoded delegate working for every user.

The owner chose `openai-codex/gpt-5.6-luna` as the default from the investigation's catalog price
comparison:

| Model                         | input $/M | output $/M | cacheRead |
| ----------------------------- | --------- | ---------- | --------- |
| `gpt-6-astra` (session model) | 10        | 50         | 1         |
| `gpt-5.6-luna` (delegate)     | 0.2       | 1.2        | 0.02      |

Catalog prices go stale; the ratio is what matters.

## Options considered

1. Do nothing. Rely on grep and bounded reads. This is the cheapest option for locating symbols, but
   it does not answer semantic questions across several large files without bulk reading.
2. Use deterministic outlines from rtk or `tsc`. The investigation found that rtk 0.48.0 `read`
   passed a TypeScript file through byte for byte, with 23,737 characters in and out. Its
   `-l aggressive` mode cut the output to 5,031 characters but truncated statements and emitted no
   line numbers. It left `import type {` unclosed and cut the arguments after
   `const result = await pi.exec(`. `tsc` declaration output is TypeScript-only. Reject this option
   because Tau must work on any codebase.
3. Use a delegate model. Choose this option because it is the only proposed bulk-read replacement
   that works across languages and answers questions rather than just listing structure.
4. Use cheap code writers. Defer this option. Portal by Spotify ships a code-writer mode but lists
   its inability to enforce that mode as a known limitation. ABU-359 already limits code writers to
   "only if 1 and 2 show a measured saving". Bulk-read delegation does not authorize code writing.

## Decision

Propose one user-configured delegate model for bulk file reads. It answers questions about file
content so the session model need not read every file in full. Keep grep and bounded reads for
questions they already answer.

### Scope of this decision

Use one configured delegate for bulk reads. This proposal does not add session-model routing, turn
classification, or per-task model selection. Pi continues to manage the session model, which still
decides and performs edits. Comment review continues to use the session model.

These limits keep this proposal focused; they do not exclude future model selection for other Tau
tools or subagents. Those decisions must follow the vision's requirement for user-configurable
models.

### User choice and availability

Read the delegate from `TAU_BULK_READ_MODEL` as `provider/id`, defaulting to
`openai-codex/gpt-5.6-luna`. Split at the first slash to preserve model IDs that contain slashes.
Resolve the reference exactly against Pi's model registry. Do not fuzzy-match or silently choose
another model. Use Pi's credentials without a credential pre-flight check.

This is Tau's first environment read in `src/`, chosen so a config file can be added on top later.
Read it at call time rather than extension load time.

Resolve the model before clamping a read, without a network call. A registry miss leaves that read
unclamped and stops trimming for the session. Resolve it again when `bulk_read` executes; a registry
miss or a hard error also stops trimming. File errors, payload caps, provider errors, and the
`error` stop reason are hard errors. Caller cancellation, the 120-second timeout, and the `length`
stop reason leave trimming on. Tool failures throw rather than return error metadata.

### Read limits and evidence

Clamp unbounded reads to a fixed 400-line threshold by setting the read tool's `limit` in the
pre-call hook. Rewrite the read result's trailing continuation notice into a hint naming
`bulk_read`. The hint uses the continuation offset from Pi's notice, including for offset reads and
the 50KB limit. Reads with an explicit `limit` pass unchanged. Pi's existing 50KB limit still
applies. The constant was kept after the
[development guide's measurement](../development.md#measuring-bulk-reads). A 400-line file with a
trailing newline gets a notice for one empty line; accept that edge case rather than adding a file
stat to the hook.

Number payload lines from 1 to match the read tool's `offset`. Answers cite `path:line`. Strip a
leading `^\d+: ` from every line of the reply so excerpts paste without payload prefixes. The
session model reads a bounded range before editing; Pi's `edit` is the exact-text check.

Send all requested files in one delegate call. Resolve paths against the session's working
directory, without restricting paths outside it. Skip NUL-byte binary files and list them in the
result. Cap each file at 400,000 bytes and the numbered request at 1,000,000 characters, matching
comment review's limits. Bound the completion to 120 seconds and 4096 output tokens. Return the
delegate's full usage on successful tool results so Pi's ledger and Tau's footer count it.

Treat file content as evidence, never as instructions, and keep the delegate read-only. Prompt
framing tells it to ignore embedded requests, answer only the question, cite file lines, and add no
tasks, commands, or URLs. Delegation does not bypass Tau's
[TDD guard](../../src/extensions/tdd/guard.ts), which explicitly allows the read-only tool because
it blocks unknown tools.

Keep `pnpm check` independent of model APIs, as required by the
[development guide](../development.md#local-setup). Offline checks can establish tool behavior and
result size, but not real-model answer quality or billing savings. Require measured savings before
expanding the scope to code writers.

## Tradeoffs

- The session model can receive an answer instead of several full files, regardless of their
  language. The delegate can still omit relevant facts or misunderstand code.
- The pre-call hook clamps rather than blocks, so an oversized read returns the file head plus a
  hint in the same turn. The hint is advisory; the model can still page with `offset`, which costs
  more than a plain read.
- Portal reports 10-30 seconds per delegation. The 2026-09-10 measurement saw about 50 seconds for a
  24k-token payload, and a median saving of 11% that sits inside run-to-run variance. Delegation
  trades latency for a modest reduction in session-model tokens.
- The roughly 90% figure reported by Portal and rtk describes a reduction in what the agent reads,
  not a reduction in the bill. Both estimate tokens as characters divided by four, without a
  tokenizer. The owner measures real providers with compaction disabled, using one semantic question
  spanning three files above the threshold. Compare trimming off with `bulk_read` present against
  the shipped setup. Run each twice on the same prompt and files and keep the medians. Record
  session and delegate usage, assistant turns, offset pages, wall clock, and catalog cost ratios in
  [Development](../development.md#bulk-read), using the session JSONL rather than hidden per-model
  rows in `/session`. Those results set the threshold and move this ADR to Accepted.
- File content reaches a weaker model whose output returns as trusted-looking bullets. Prompt
  framing is the mitigation, and it is weaker than in Tau's other uses of it. The delegate has no
  tools, so injected content cannot act. Citation instructions do not establish that an answer is
  safe or correct. Tau does not detect hostile text that cites a real line.
- A model that is in the registry but rejected by the provider costs one clamped read and one failed
  delegate call before trimming stops.
- A failed delegate call throws, so its usage is not recorded; only successful calls reach the
  ledger.
- On a subscription, reported cost is catalog pricing. Treat it as a ratio, not an invoice. User
  configuration also means each account can have different working models and costs.

## See also

- [Vision](../vision.md)
- [ADR 0008: Coding instructions](./0008-coding-instructions.md)
- [Comment review](../comment-review.md)
- [ADR 0005: Integration testing against a real Pi session](./0005-integration-testing-with-pi.md)
