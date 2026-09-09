# ADR 0009: Delegate model for bulk reads

- Status: Proposed
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

The user chooses the delegate's provider and model ID. Do not ship a hardcoded pair or silently
choose another model when a call fails. Users need to choose a model their account can access and
whose cost and quality fit their needs.

Use Pi's model registry and credentials rather than separate authentication or a settings loader. Pi
0.85.1 has no settings slot for extension config; its extension flags are the available per-user
control. Ordinary reads must remain available when no delegate is configured or a delegate call
fails. A successful credential check must not be treated as proof that the model can answer.

### Read limits and evidence

Use a configurable threshold to steer oversized reads toward delegation while preserving bounded
reads. Pi already truncates reads at 2000 lines or 50KB, whichever comes first. A lower threshold
adds a limit rather than duplicating that truncation. Choose its value from measured results, not a
claim that delegation always saves money.

Require verbatim source snippets when a delegate answer supports an edit. Tau must check that each
anchor appears exactly once in the named file before presenting it as editing evidence. Pi's edit
tool uses exact text matches, so line numbers alone are insufficient. This check establishes that
the text exists, not that the delegate interpreted it correctly.

Treat file content as evidence, never as instructions, and keep the delegate read-only. Prompt
framing must tell it to ignore requests embedded in files to change its policy or redirect its
answer. Delegation does not bypass Tau's [TDD guard](../../src/extensions/tdd/guard.ts), which must
explicitly allow the read-only tool because it blocks unknown tools.

Keep `pnpm check` independent of model APIs, as required by the
[development guide](../development.md#local-setup). Offline checks can establish tool behavior and
result size, but not real-model answer quality or billing savings. Require measured savings before
expanding the scope to code writers.

## Tradeoffs

- The session model can receive an answer instead of several full files, regardless of their
  language. The delegate can still omit relevant facts or misunderstand code.
- Pi's pre-call hook can block a read but cannot substitute a result, so a blocked read costs an
  extra turn. The worst case is three turns where one read would have done: a blocked read,
  delegation, and a bounded re-read before editing.
- Portal reports 10-30 seconds per delegation. Below roughly 800 lines, delegation may take longer
  and use more total tokens than reading the file directly. The threshold needs tuning; 800 lines is
  not a measured Tau break-even point.
- The roughly 90% figure reported by Portal and rtk describes a reduction in what the agent reads,
  not a reduction in the bill. Both estimate tokens as characters divided by four, without a
  tokenizer. Measure delegate input, output, extra session turns, elapsed time, and reported cost
  separately from the reduction in what the session model reads.
- File content reaches a weaker model whose output returns as trusted-looking bullets. Prompt
  framing is the mitigation, and it is weaker than in Tau's other uses of it. Exact anchor checks do
  not establish that the delegate's interpretation is safe or correct.
- On a subscription, Pi's reported cost comes from catalog pricing and may not reflect actual
  billing. User configuration also means each account can have different working models and costs.

## See also

- [Vision](../vision.md)
- [ADR 0008: Coding instructions](./0008-coding-instructions.md)
- [Comment review](../comment-review.md)
- [ADR 0005: Integration testing against a real Pi session](./0005-integration-testing-with-pi.md)
