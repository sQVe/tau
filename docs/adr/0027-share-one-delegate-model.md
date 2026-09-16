# ADR 0027: Share one delegate model across bounded tool tasks

- Status: Accepted
- Date: 2026-09-16

## Context

Bulk reads and web answers already share a model, while comment review uses Pi's session model.
ABU-391 asks for independent provider and model selection across these three tasks to reduce cost.
Comment review can block commits, so lower catalog prices alone do not justify changing its default.

The owner chose lower cost with preserved review quality over lower latency. The owner also approved
removing `TAU_BULK_READ_MODEL` without compatibility handling because Tau has no other users.

## Options considered

1. Keep comment review on the session model. This avoids a new review-quality risk but ties a
   bounded tool call to the model chosen for implementation work.
2. Share one configurable delegate after a labeled comparison. Choose this option because the
   existing delegate passed the agreed review gate at lower measured catalog cost.
3. Add task routing or a settings UI. Reject these additions because the three callers need one
   independent default, not another model-selection system.

## Decision

Use one configurable delegate for bulk reads, web answer mode, and commit comment review. Replace
ADR 0014's environment setting and its requirement to keep comment review on the session model. Keep
its other bulk-read decisions unchanged.

Use `TAU_DELEGATE_MODEL=provider/model-id`, defaulting to `openai-codex/gpt-5.6-luna` when unset or
empty. Resolve references exactly through Pi's registry and credentials. Remove the old setting
rather than maintain an alias. Read configuration at call time without changing Pi's session model.

Preserve the web tool's per-call `answerModel` override. Keep Tau's existing precedence over the web
package's persistent answer-model settings. Reject invalid references and failed delegates; never
silently change models or providers. A failed review cannot authorize a commit. Ordinary reads must
remain available when bulk delegation fails.

Keep task prompts, input boundaries, finding validation, and blocking versus advisory rules with
their callers. Shared selection does not authorize general code review or implementation delegation.

### Configuration and execution boundaries

The shared setting is a default, not a requirement that every task always use the same model.
[ABU-369](https://linear.app/aburaya/issue/ABU-369) records future granular configuration. When that
consumer is implemented, select an explicit per-call override where supported, then a task-specific
setting, then the shared setting, then the built-in default. This is selection precedence, not
fallback after failure. File schema and environment-versus-file precedence remain future decisions;
this change adds no task settings or general router.

Keep bounded requests separate from agent workers. These callers supply the evidence and validate
the result. Their delegates have no tools, independent agent loop, or resumable worker conversation.
Bounded retries do not change that boundary.

[ABU-327](https://linear.app/aburaya/issue/ABU-327) owns interactive investigators and editing
workers, including permissions, questions, deadlines, durable reports, recovery, and herdr
placement. Do not launch bounded requests in background herdr tabs merely for visibility. Activity
reporting does not require worker sessions or their added lifecycle. Sharing model configuration
must not grant worker authority or require shared execution machinery.

[ABU-367](https://linear.app/aburaya/issue/ABU-367) owns general code-review policy and uses
ABU-327's investigator and verifier execution. Bounded commit comment review remains separate.

### Default comparison

On 2026-09-16, compare `openai-codex/gpt-5.6-luna` with the session model,
`openai-codex/gpt-6-astra`, using source from commit `10292ef68ec8615aadb97f60004035350a0500c9`. Run
each case three times per model, alternating model order between rounds. Use production
`reviewComments`, real temporary Git trees, the unchanged review prompt and validation, and no
conversation history. Neither model receives the expected labels.

The agreed review gate requires no false blocking findings, no missed seeded inaccuracies, correct
narration findings, and lower total catalog cost including validation retries. A failed gate
requires owner discussion before choosing another model or default.

| Review case                  | Supplied change                                                                                                 | Expected result                   | Luna, three runs        | Astra, three runs       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------- | ----------------------- |
| Useful constraint            | Change expiry from 30 to 45 seconds; explain the upstream 60-second lease and clock-drift margin                | No blocking finding               | Clean throughout        | Clean throughout        |
| Obvious narration            | Add "Add one to value and return it" above `return value + 1`                                                   | Policy finding                    | Found throughout        | Found throughout        |
| Unchanged inaccurate comment | Keep the zero-limit-returns-all comment; remove the zero-limit special case before `slice(0, limit)`            | Inaccuracy finding                | Found throughout        | Found throughout        |
| Changed inaccurate comment   | Add a five-second timeout comment above `timeoutMilliseconds = 30_000`                                          | Inaccuracy finding                | Found throughout        | Found throughout        |
| Missing explanation          | Change `return expiresAt` to `return expiresAt - 37_000` without a comment                                      | Advisory or clean, never blocking | One advisory, two clean | One advisory, two clean |
| Required directive           | Rename an export to `lease_seconds`; add a naming-rule directive and explain the generated-protocol requirement | No blocking finding               | Clean throughout        | Clean throughout        |

Both models found all six seeded inaccuracy instances and all three narration instances. Neither
produced a false blocking finding. No review output needed a validation retry, and no provider error
was observed. The advisory responses inferred time units not established by the fixture; those
suggestions are not authoritative evidence.

Also run one bulk-read question and one web-answer question three times per model. The bulk question
asks about model selection, overrides, and clamping failures across `bulkRead/index.ts`,
`bulkRead/tool.ts`, and `webAccess/index.ts`. The web question asks about the delegate setting,
default, override, and credentials from the development guide, supplied to production
`answerFromPage`. This checks page answering, not live web extraction.

| Task           | Calls per model | Luna total catalog cost | Astra total catalog cost | Luna median seconds | Astra median seconds |
| -------------- | --------------: | ----------------------: | -----------------------: | ------------------: | -------------------: |
| Comment review |              18 |               $0.003273 |                $0.121230 |               4.372 |                4.495 |
| Bulk read      |               3 |              $0.0047874 |                $0.182460 |              14.335 |               17.216 |
| Web answer     |               3 |               $0.001482 |                $0.067990 |               4.298 |                6.700 |

Sum usage from every completion response, including invalid responses if any, rather than comparing
per-call prices. No extra completion attempts occurred, so observed validation-retry cost was zero.
Both models used 24,978 input tokens across the comparison, with no cache reads or writes. Luna used
3,789 output tokens; Astra used 2,438. Catalog costs are comparison estimates, not subscription
bills. Transport retries without reported usage are not separately measurable from these completion
results.

The supporting answers identified the setting, override, and main failure boundaries. Luna twice
called the exactly-empty fallback "blank" and once mislabeled timeout errors as `AbortError`. Astra
retained those distinctions. These are limits of the existing bulk delegate, not evidence of equal
summary quality. Keep bounded source checks for consequential claims. The review gate passed; this
comparison does not expand bulk-read authority.

The complete rerun's inputs, outputs, timings, and usage are saved locally under
`~/.pi/agent/evaluations/abu-391/`. An earlier run lost its temporary artifacts and is excluded from
these totals. The tables record the evidence used for this decision without requiring that local
artifact directory.

## Tradeoffs

- One setting selects an independent model without a routing framework.
- The labeled review comparison supports a cheaper default for these bounded tasks.
- Cost: six small synthetic review cases do not establish equal quality on large or unfamiliar
  changes.
- Cost: model availability and quality can change. Repeat the comparison before changing the
  default.
- Cost: an unavailable delegate blocks commits until its configuration or authentication is fixed.
- Cost: removing the old setting requires the owner to change their launch environment.

## See also

- [ADR 0014: Delegate model for bulk reads](./0014-delegate-model-for-bulk-reads.md)
- [Development](../development.md)
