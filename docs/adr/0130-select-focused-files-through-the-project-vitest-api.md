# ADR 0130: Select focused files through the project's Vitest API

**Date**: 2026-11-10\
**Status**: Accepted

## Context

Focused test evidence must identify the selected files exactly. Vitest's CLI matches filename
filters by substring, including absolute paths. A filter for `value.test.ts` can also run
`other-value.test.ts`. The CLI has no flag for exact file selection.

The project's Vitest installation owns its configuration, test discovery, and runner behavior. Using
a different installation would make focused evidence depend on Tau's dependencies rather than the
project's runner.

## Decision

Tau runs focused tests on Vitest 2.1.0 or later through the project's public node API in a Tau-owned
TypeScript entry launched with Node. Older versions use the CLI with positional file filters and
`-t`, preserving its substring file matching.

The entry uses the installation already resolved for the project's CLI. It calls `startVitest` and
follows the CLI's bounded exit and startup-error handling. Vitest owns initialization, source
relevance, coverage, project startup, reporting, and teardown rather than Tau assembling those
steps.

A reporter initialization hook wraps each project's public `globTestFiles` method. The wrapper calls
Vitest's method, then retains only returned test and typecheck files whose resolved paths equal a
requested path. It does not change configured include patterns or pass substring filename filters.
This keeps project boundaries, configured exclusions, and files outside configured includes under
Vitest's control. Exact file selection is the intended difference from CLI execution.

Where the public parser omits private CLI option normalization, Tau keeps a small tested adapter
rather than importing internal Vitest modules. The process boundary keeps project configuration and
test execution outside Pi, while preserving Tau's timeout and cancellation control.

The TypeScript entry ships with Tau's source and uses Node's native TypeScript support. It needs no
separate build artifact. Affected and full runs keep the CLI boundary because they do not need exact
file selection.

Focused runs require Tau outside `node_modules` because Node refuses type stripping there. The
[documented local-path and Git installs](../development.md#try-tau) meet this constraint.

## Consequences

### Positive

- Focused evidence cannot include another file merely because its path contains the selected path.
- The project's runner continues to own configuration, source relevance, and reports.
- Test execution stays in a child process controlled by Tau.

### Negative

- Tau must test the adapter against changes to Vitest's public API and CLI semantics.
- The discovery adapter depends on the public initialization hook running before project discovery.
- Private CLI option normalization requires a small local equivalent.
- The entry depends on Node's native TypeScript support at runtime.

## Alternatives considered

### Keep CLI filename filters

Pass relative, absolute, or escaped paths to the CLI. Rejected because those filters still use
substring matching, so they cannot establish exact file identity.

### Override include patterns

Replace configured includes with escaped literal paths. Rejected because a root override can admit
files outside configured includes and does not replace inline projects' include patterns.

### Assemble the run from lower-level APIs

Initialize Vitest, select specifications, and run them directly. Rejected because Tau would own run
lifecycle details, including first-run coverage and which projects initialize browser providers.

### Use a Tau-owned Vitest installation

Run the node API from a Vitest dependency owned by Tau. Rejected because it could differ from the
project's version and configuration behavior.
