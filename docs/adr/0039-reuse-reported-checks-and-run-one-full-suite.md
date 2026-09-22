# ADR 0039: Reuse reported checks and run one full suite per work state

- Status: Proposed
- Date: 2026-09-22

## Context

An autonomous worker runs the repository's required checks and reports the result. A manager decides
acceptance from that handoff, and a reviewer inspects the work. Earlier instructions asked a worker
for both a full `run_tests` pass and `pnpm check`, which run the same test suite. Managers also ran
`pnpm check` again after a passing handoff. Each repeat spends time and tokens without producing new
evidence about the same inputs.

## Options considered

- Require every agent to run the required checks independently. This treats a reported pass as
  untrusted, but it reruns the same suite on unchanged inputs and does not inspect the diff.
- Keep separate bookkeeping passes for TDD verification and the repository gate. This runs the full
  suite twice on one work state and teaches agents to rerun for process reasons.
- Treat one full check as satisfying both, and reuse worker-reported checks unless a concrete reason
  says otherwise. This keeps diff review and targeted reproduction, which are the checks that find
  defects.

## Decision

A full check that already ran the suite on the current inputs satisfies full verification, whether
it came from `run_tests` or the repository's own full check such as `pnpm check`. One worker
execution can satisfy a required shared check. Do not run a second equivalent full suite only for
bookkeeping.

### Reuse and rerun reasons

Reuse worker-reported checks as evidence for the work state they name. Repeat a check only for a
concrete reason: relevant changes since the check, missing or contradictory evidence that execution
must resolve, a targeted defect reproduction, an integration change, or an explicit mandatory gate.
Use the smallest check that resolves the reason. A new session, another model, or an absent
session-local observation is not a reason.

### Accepting evidence is not accepting correctness

Accepting reported checks is not a correctness claim. Review reads the test diff before the
implementation diff, inspects the actual source, and verifies a suspected finding without repeating
the full suite. Mandatory Git hooks, CI, and explicit user requests stay in force. Do not infer that
an unrun check passed or that an old result covers changed inputs.

## Tradeoffs

- One full suite can satisfy TDD verification and the repository gate on the same inputs.
- Worker-reported evidence is trusted by default, so a simple reporting gap is closed by reading the
  saved output or asking the worker.
- Cost: a dishonest or mistaken report is not detected by a second run of the same command.
- Cost: the rule relies on agents naming the work state a check covered and disclosing later edits.

## See also

- [ADR 0023: Use advisory TDD observations instead of edit permissions](./0023-advisory-tdd-observations.md)
- [ADR 0010: Documentation scope](./0010-documentation-scope.md)
