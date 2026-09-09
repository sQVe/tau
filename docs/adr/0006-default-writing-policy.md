# ADR 0006: Default writing policy

- Status: Accepted
- Date: 2026-09-07

## Context

- Tau needs clear, consistent writing in replies and documents.
- Pi loads a skill when needed, so its full rules may be missing from an ordinary reply.
- ADR 0004 puts rules in ADRs or code, and task instructions in skills.
- Writing defaults must respect the task and repository rules.

## Options considered

- Keep current behavior. Sets no default writing rules.
- Ship only an unslop skill. Helps with editing requests but must be loaded first.
- Load a policy through a Pi extension. Includes the same rules in each ordinary agent run.
- Rewrite responses automatically. Takes more time and risks changing meaning.

## Decision

Use a Pi extension to load one writing policy from the Tau package into every ordinary agent run.

### Policy ownership and scope

Keep the agent instructions beside the writing extension in
[`src/extensions/writing/instructions.md`](../../src/extensions/writing/instructions.md). Load this
same file into the agent prompt. It addresses the agent directly; contributor docs may link to it
when the same rules apply. This ADR records the decision and does not restate the rules.

The rules cover replies, progress updates, commit and PR text, tickets, docs, and code comments.
They ask for plain language aimed at readers who use English as a second language, and they keep the
meaning, sources, and required formats unchanged. The task and repository rules come first. The
policy guides the agent; it cannot guarantee good writing.

### Runtime integration

Include the complete writing guidance in the system prompt before each ordinary agent run. Keep the
existing prompt and include the guidance once, so it does not build up across runs. Reloading the
extension picks up changes to the guidance.

The rules stay available while the agent uses tools or handles messages during a run. Compaction and
branch summaries use separate prompts and are outside this decision. Other extensions may replace
the prompt.

Reject missing, unreadable, or blank guidance when loading Tau. Accept a visible load failure
instead of silently running without the writing rules. In Pi 0.66.1, this prevents CLI startup and
discards all Tau features; reload and SDK callers may handle the error differently.

This extension defines no types of its own and may omit `types.ts`, an exception to ADR 0001.

### Editing skill

Defer a separate editing skill until editing requests need a shared procedure. It will link to the
writing guidance without copying the rules. Loading the default policy does not depend on a skill.

## Tradeoffs

- One file supplies the instructions for the agent and a reference for contributors.
- Ordinary replies receive the rules without loading a skill.
- Cost: the policy uses space in the prompt on each run.
- Cost: prompt instructions cannot guarantee good writing, and other extensions can replace them.
- Cost: the package must include the policy file. A load error disables Tau and blocks CLI startup.
- Cost: compaction and branch summaries do not receive the policy.

## See also

- [ADR-0001: Application structure](./0001-application-structure.md)
- [ADR-0004: Skill authoring style](./0004-skill-authoring-style.md)
- [ADR-0008: Coding instructions](./0008-coding-instructions.md). It amends the scope above and
  moves the rules about which comments to keep.
- [Agent writing instructions](../../src/extensions/writing/instructions.md)
- [Documentation rules](../AGENTS.md)
