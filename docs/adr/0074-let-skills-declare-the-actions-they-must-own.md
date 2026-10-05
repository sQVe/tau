# ADR 0074: Let skills declare the actions they must own

**Date**: 2026-09-30\
**Status**: Accepted\
**Related**: [ADR 0051 (Note the bare root rule instead of enforcing it)](./0051-note-the-bare-root-rule-instead-of-enforcing-it.md),
[ADR 0066 (Add Tau's prompt text to Pi's append section)](./0066-add-taus-prompt-text-to-pis-append-section.md),
[ADR 0067 (Give workers only their profile's tools and skills)](./0067-give-workers-only-their-profile-tools-and-skills.md)

## Context

Some skills must run whenever the agent takes an action, such as opening a pull request. An agent
opened pull requests with plain `gh pr create` because that step was part of its own plan. The `pr`
skill description only matches phrases a user would say.

The skills run the same commands they protect, such as `gh pr create`,
`git push --force-with-lease`, and `grove add`. A command guard cannot tell a skill's call from a
plain one.

## Decision

A skill that must own an action declares it in `metadata.required-for` in its frontmatter. The value
completes "Use the `<name>` skill whenever you are ...". Tau turns the field into a prompt line, so
the rule lives with the skill.

### Field rules

- The field lives under `metadata`, because the Agent Skills spec allows custom data only there.
  [ADR 0004](./0004-skill-authoring-style.md) requires valid Agent Skills frontmatter.
- Tau appends one line to the system prompt for each skill with `metadata.required-for`.
- Tau reads the field once at load. It refuses to load when a value is empty or not a string, and it
  names the skill file.
- Tau also refuses to load when Pi reports a problem with a Tau skill file, such as broken YAML. Pi
  skips such a skill with a warning, which would drop its rule without an error.
- Workers get no lines, because they load only the skills their profile names.

## Consequences

### Positive

- The rule is next to the skill, so adding the field to a new skill is enough.

### Negative

- Enforcement is prompt text. An agent that ignores the line can still run the command.

## Alternatives considered

### `bash` guard

Refuse the commands in a `bash` guard. Rejected because it would also refuse the skills that run
them.

### Workflow instructions

Add the rules to the workflow instructions. Rejected because the rule would live apart from the
skill it protects and could drift from it.

### Wider skill descriptions

Widen each skill description. Rejected because descriptions help Pi choose a skill for a user
request, and a long list of actions makes them harder to read.
