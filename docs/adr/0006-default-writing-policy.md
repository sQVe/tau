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

This ADR sets the default writing rules. Keep the full writing guidance in `docs/guides/writing.md`,
using the guide template. The guide explains how to apply these rules; it does not add new rules.
Load that same file into the agent prompt.

Cover replies, progress updates, commit and PR text, tickets, docs, and code comments. Write for
readers who use English as a second language. Prefer common words, short sentences, and one idea per
sentence. Explain technical terms when needed. Docs and posts may have more personality, but should
use the same simple language.

Cut filler and repetition, name sources, and keep formatting useful. End replies without repeating
the answer. Keep comments that explain what the code cannot. Review text silently before sending or
saving it.

Keep the meaning, sources, and any real uncertainty. Preserve exact text in quotations and code, and
follow required formats. The task and repository rules come first. Editing comments does not give
permission to refactor code. The policy guides the agent; it cannot guarantee good writing.

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

- One file supplies the rules for readers and the agent.
- Ordinary replies receive the rules without loading a skill.
- Cost: the policy uses space in the prompt on each run.
- Cost: prompt instructions cannot guarantee good writing, and other extensions can replace them.
- Cost: the package must include the policy file. A load error disables Tau and blocks CLI startup.
- Cost: compaction and branch summaries do not receive the policy.

## See also

- [ADR-0001: Application structure](./0001-application-structure.md)
- [ADR-0004: Skill authoring style](./0004-skill-authoring-style.md)
- [Documentation rules](../AGENTS.md)
- [Guide template](../guides/TEMPLATE.md)
