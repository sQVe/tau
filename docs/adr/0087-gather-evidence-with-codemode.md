# ADR 0087: Gather evidence with codemode

**Date**: 2026-10-05\
**Status**: Accepted; script scope and the tools a script may call superseded by
[ADR 0092 (Use codemode only to batch or filter evidence)](./0092-use-codemode-only-to-batch-or-filter-evidence.md);
history tool references superseded by
[ADR 0097 (Track only the current session's workers)](./0097-track-only-the-current-sessions-workers.md)\
**Supersedes**:
[ADR 0014 (Delegate model for bulk reads)](./0014-delegate-model-for-bulk-reads.md),
[ADR 0022 (Gate the clamped read hint on the remainder)](./0022-gate-the-clamped-read-hint-on-the-remainder.md),
the bundled tool lists in
[ADR 0067 (Give workers only their profile's tools and skills)](./0067-give-workers-only-their-profile-tools-and-skills.md),
the `bulk_read` section in
[ADR 0072 (Keep model defaults out of code)](./0072-keep-model-defaults-out-of-code.md), and the
`bulkRead` key handling in
[ADR 0085 (Group per-repository settings in the user config)](./0085-group-per-repository-settings-in-the-user-config.md)\
**Related**:
[ADR 0067 (Give workers only their profile's tools and skills)](./0067-give-workers-only-their-profile-tools-and-skills.md)
for profile tool allowlists,
[ADR 0095 (Keep repository routing in tracker config)](./0095-keep-repository-routing-in-tracker-config.md)
for config placement and validation

## Context

`bulk_read` sends file reading to a cheaper model and trims long reads. Agents then cite the
delegate's summary instead of the source.

Codemode runs one script that calls the session's tools and returns only what the script keeps. One
script can gather the same evidence without a second model and without raw output in context.

A script can call any tool the session allows. Without a limit, a script could send a worker report,
ask the user a question, or launch a worker, and Tau's rules for these calls assume the model makes
them directly.

Scripts read the structured result of `bash`. Hooks that rewrite the model-facing text must not drop
that result.

## Decision

Codemode is Tau's way to gather evidence, for the manager and for the scout, reviewer, and worker
profiles. `bulk_read` is removed, with no alias and no summary replacement. With codemode scripts
that return bounded excerpts, the session model reads the source lines it cites, and one script
replaces many tool calls.

### Scripts return evidence, not raw output

- Plan one script per evidence set. The script returns bounded, line-numbered excerpts with command
  status and the gaps it found.
- Agents cite only what a script returned. A fact the script filtered out must be gathered and
  returned before an agent cites it.
- Skills gather their evidence with one script that composes tested readers. Target resolution,
  approvals, writes, and review judgment stay outside the script.

### Profiles

- The scout, reviewer, and worker profiles list `codemode` by name. The qa and browser profiles do
  not.
- `codemode` is not in the shared worker tool set. A script can call only the tools of its profile.
- A custom profile that still names `bulk_read` fails at startup. Tau does not substitute another
  tool.

### Control tools stay out of scripts

- Report, question, progress, user question, and orchestration write tools are model-only:
  `subagent_report`, `subagent_question`, `subagent_progress`, `ask_user_question`, `subagent`,
  `subagent_follow_up`, `subagent_reply`, and `subagent_cancel`. Pi's model-only exposure keeps them
  out of script discovery and script calls.
- These tools also reject a call that a script made. This is defense in depth, in case a later Pi or
  another caller lets a nested control call through.
- `subagent_status` and `subagent_history` only read, so scripts may call them.

### Structured results survive hooks

A hook that changes the model-facing text of a tool result keeps its structured result unchanged.

### Config

`bulkRead` is no longer a Tau key. Old `bulkRead` keys in the user file cause no error. They are not
on the list of removed keys, because nothing replaces them.

## Consequences

### Positive

- Agents cite source lines instead of a delegate's summary.
- One script replaces a chain of reads and searches, and raw output stays out of context.
- One model fewer to configure.
- Control calls keep their rules, because only the model makes them.

### Negative

- The session model pays for the evidence it reads, where `bulk_read` passed bulk reading to a
  cheaper model.
- A script that filters too much hides facts. The citation rule makes the agent gather them again,
  which costs another script.
- The qa and browser workers keep gathering evidence one tool call at a time.

## Alternatives considered

### Keep `bulk_read` next to codemode

Keep `bulk_read` next to codemode. Rejected because two ways to gather evidence split the
instructions, and the delegate summaries remain uncited secondhand claims.

### Codemode script with a cheaper model summary

Replace `bulk_read` with a codemode script that asks a cheaper model for a summary. Rejected because
it keeps the same uncited summaries.

### Codemode for every worker profile

Give codemode to every worker profile. Rejected because qa and browser workers act in a browser and
do not gather repository evidence in bulk.
