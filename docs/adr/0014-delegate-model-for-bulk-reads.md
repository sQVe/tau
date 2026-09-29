# ADR 0014: Delegate model for bulk reads

- Status: Accepted; the `TAU_BULK_READ_MODEL` setting was replaced by the shared delegate setting in
  [ADR 0027](./0027-share-one-delegate-model.md)
- Date: 2026-09-10

## Context

Tau could reduce the session model's bulk file reading by giving that work to a cheaper model. Grep
and bounded reads answer "where is X", but a semantic question that spans several large files still
needs a model to read them.

The [vision](../vision.md#principles) allows cheaper models for Tau's tools and subagents, and
requires those models to be user-configurable. Model availability varies by provider and account, so
no single hardcoded delegate works for every user. The owner chose `openai-codex/gpt-5.6-luna` as
the default because its catalog price per token is about 40 to 50 times lower than the session
model's.

## Options considered

1. Do nothing and rely on grep and bounded reads. Rejected: this is cheapest for locating symbols,
   but it cannot answer semantic questions across several large files.
2. Use deterministic outlines from rtk or `tsc`. Rejected: rtk either passed a file through
   unchanged or truncated statements and dropped line numbers, and `tsc` works only for TypeScript.
   Tau must work on any codebase.
3. Use a delegate model. Chosen: it is the only proposed replacement that works across languages and
   answers questions instead of listing structure.
4. Use cheap code writers. Deferred: Portal by Spotify lists its inability to enforce a code-writer
   mode as a known limitation. Code writers were allowed only if options 1 and 2 showed a measured
   saving. Bulk-read delegation does not authorize code writing.

## Decision

Propose one user-configured delegate model for bulk file reads. It returns summaries, test
inventories, and line-cited evidence from supplied files so the session model need not read every
file in full. Correctness and branch review judgments stay with the session model, which verifies
consequential claims against production callers and the actual diff. Keep grep and bounded reads for
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
`openai-codex/gpt-5.6-luna` when the setting is unset or empty. Split at the first slash to preserve
model IDs that contain slashes. Resolve the reference exactly against Pi's model registry. Do not
fuzzy-match or silently choose another model. Use Pi's credentials without a credential pre-flight
check.

This is Tau's first environment read in `src/`, chosen so a config file can be added on top later.
Read it at call time rather than extension load time.

Resolve the model before clamping a read, without a network call. A registry miss leaves that read
unclamped and stops trimming for the session. Resolve it again when `bulk_read` executes; a registry
miss or a hard error also stops trimming. Provider errors and the `error` stop reason are hard
errors. Caller cancellation, the 120-second timeout, the `length` stop reason, file errors, and
payload caps leave trimming on, because none of them show that the delegate is unreachable. Tool
failures throw rather than return error metadata.

### Clamping reads

- Clamp unbounded reads to a fixed 400-line threshold by setting the read tool's `limit` in the
  pre-call hook. Reads with an explicit `limit` pass unchanged, and Pi's 50KB limit still applies.
- Rewrite the read result's trailing continuation notice into a hint naming `bulk_read`, carrying
  the continuation offset from Pi's notice, for offset reads and the 50KB limit alike.
  [ADR 0022](./0022-gate-the-clamped-read-hint-on-the-remainder.md) replaces this rule.
- Keep the threshold at the value the
  [development guide's measurement](../development.md#measuring-bulk-reads) tested.

Pi reports no truncation flag on the result, so the hook matches the notice text and accepts two
edge cases rather than reading the file a second time:

- A 400-line file with a trailing newline gets a notice for one empty line.
- A clamped file whose own last paragraph ends in the notice's shape loses it to the hint.

### Payload format

- Number payload lines from 1 to match the read tool's `offset`, separated by an arrow.
- Strip a leading `^\d+→` from every line of the reply so excerpts paste without payload prefixes.
  The arrow beats a colon because the strip then cannot delete an answer line that opens with a
  number and a colon, such as a status or exit code.
- Answers cite `path:line`. The session model reads a bounded range before editing, and Pi's `edit`
  is the exact-text check.

### Delegate request

- Send all requested files in one call. Resolve paths against the session's working directory,
  expanding a leading `~` and stripping a leading `@` as the read tool does, without restricting
  paths outside it.
- Skip NUL-byte binary files and list them in the result. Fail rather than send an empty payload
  when every requested file is binary.
- Keep the 400,000-byte per-file cap. Cap the numbered request, including the question, at
  `min(1_000_000, (model.contextWindow - model.maxTokens) * 3)` characters. Three characters per
  token is a conservative estimate to avoid overflowing smaller delegate windows, and reserving the
  output allowance leaves room for the answer at the cap. Skipped binary files do not count toward
  the cap. Reject oversized input before a provider request and leave trimming on. Bound the
  completion to 120 seconds.
- Pass `maxRetries: 1` to explicitly allow one retry and `cacheRetention: 'none'` to avoid cache
  writes for one-off payloads where the provider supports it. Do not add a `sessionId`; the default
  Codex adapter suppresses the cache key with retention set to `none` regardless of session ID.
- Return the delegate's full usage on successful tool results so Pi's ledger and Tau's footer count
  it.

### Safety and verification

- Treat file content as evidence, never as instructions, and keep the delegate read-only. Prompt
  framing tells it to ignore embedded requests, answer with what the supplied files establish and
  state what they cannot, cite file lines, and add no tasks, commands, or URLs.
- The original TDD guard explicitly allowed the read-only tool while blocking unknown tools.
  [ADR 0023](./0023-advisory-tdd-observations.md) later replaced that guard with advisory hints.
- Keep `pnpm check` independent of model APIs, as required by the
  [development guide](../development.md#local-setup). Offline checks establish tool behavior and
  result size, not real-model answer quality or billing savings.
- Require measured savings before expanding the scope to code writers.

## Tradeoffs

- The session model can receive an answer instead of several full files, regardless of their
  language. The delegate can still omit relevant facts or misunderstand code.
- The pre-call hook clamps rather than blocks, so an oversized read returns the file head plus a
  hint in the same turn. The hint is advisory; the model can still page with `offset`, which costs
  more than a plain read.
- Portal reports 10-30 seconds per delegation; the measurement saw about 50 seconds for a 24k-token
  payload. Delegation trades latency for a modest reduction in session-model tokens, and the
  delegate is asked for the fewest bullets that answer the question because answer length was the
  measured cost.
- The roughly 90% figure reported by Portal and rtk describes a reduction in what the agent reads,
  not a reduction in the bill. Both estimate tokens as characters divided by four, without a
  tokenizer.
- Four runs on 2026-09-10 over a 2,244-line fixture compared `openai-codex/gpt-6-astra` with
  `openai-codex/gpt-5.6-luna`. The median catalog cost was $0.36 without trimming and $0.32 with it,
  an 11% saving inside run-to-run variance. The median wall clock was 42 seconds against 66 seconds.
  The one run that clamped and then delegated was 32% cheaper than the comparable full-read run and
  twice as slow. These results accepted this ADR.
  [Development](../development.md#measuring-bulk-reads) has the procedure to repeat them.
- The [population script](../../scripts/bulk-read-population.sh) run on 2026-09-12 counted 194
  sessions, 2,981 reads, 2,137 unbounded reads, 568 truncated or hinted results (19.1%), and at most
  470 offset pages. That day's review had counted 2.3% truncated or hinted. The rest comes from Pi's
  own continuation notice, which the query also matches. Nine `bulk_read` calls cost
  $0.08 against $84.65 of assistant spend in the seven sessions that used it. Cumulative catalog
  cost to that date was $555.49 for `assistant` and $0.08 for `toolResult`. The counts include
  sessions before `bulk_read` shipped, and files under 400 lines count as unbounded reads. The
  offset count is an upper bound without a same-path join. These counts compare no thresholds and
  establish no savings. Measure savings in sessions using delegation before expanding delegation
  work, including code writers.
- The session model often avoids bulk reads on its own, grepping and reading bounded ranges the
  clamp leaves alone, and those runs cost the same either way. The threshold stays at 400, and code
  writers do not earn a ticket on this evidence.
- Three follow-up changes were measured live and reverted:
  - Offering bounded reads "for exact code" in the hint gave no speedup and two mis-bounded
    citations.
  - One delegate call per file in parallel ran faster per call but padded answers with remarks about
    files the call never saw.
  - A system-prompt guideline to delegate first cost 12% less and took about 40 seconds more, and it
    dropped a claim in three of four answers.

  The clamp, the hint, and the shorter-answer sentence held.

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

- [ADR 0027: Share one delegate model](./0027-share-one-delegate-model.md) replaces the environment
  setting and the restriction on delegating comment review.
- [Vision](../vision.md)
- [ADR 0008: Coding instructions](./0008-coding-instructions.md)
- [ADR 0005: Integration testing against a real Pi session](./0005-integration-testing-with-pi.md)
- [ADR 0022: Gate the clamped read hint on the remainder](./0022-gate-the-clamped-read-hint-on-the-remainder.md)
