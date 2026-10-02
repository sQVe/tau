# ADR 0082: Own Linear conventions in one tracker skill

- Status: Accepted
- Date: 2026-10-02

## Context

- Agents write Linear tickets from several skills and from plain conversation. Only `slice` and
  `start-slice` carried ticket rules, and each held a different part of them.
- A ticket written outside those skills, such as a bug or a follow-up, followed no rules for its
  shape, team, or status.
- Tickets go to two places: human tickets to the repository's team and project, agent tickets to a
  shared agent team. The config named only the agent team, so the human route came from asking each
  time.

## Options considered

- Keep the rules in each skill that writes to Linear. Rejected: the copies drift, and writes from
  other paths stay unruled.
- Put the rules in the workflow instructions. Rejected: every session would load Linear rules,
  including sessions that never touch Linear.
- Give one `tracker` skill the ticket types, templates, routing, and `linear` commands, and have
  other skills follow it at their Linear writes. Chosen: one place to change, and any Linear write
  can load it.

## Decision

One `tracker` skill owns how Tau writes to Linear. Other skills keep only their own logic and follow
it at each step that writes a ticket, a relation, or a status.

### Config

- A `tracker` key in the user's `tau.json` replaces `slice`. It holds `agentTeam` and
  `repositories`, keyed by the `origin` remote's `owner/name`, each with a `team` and an optional
  `project`. The old `slice` key is an error that names the new key; there is no alias.
- Only the user file may set `tracker`, because it names where the manager writes.
- Tau adds the agent team and the current repository's route to the manager prompt. A missing entry,
  a missing origin, or an invalid config becomes a prompt line, and the skill stops with a setup
  message.

### Status

- Starting a slice moves it to In Progress. Linear's GitHub integration moves a ticket to Done once
  the PR that fixes it merges. Agents make no other status change.

## Tradeoffs

- A bug or follow-up gets the same shape and route as a planned slice.
- Routing comes from config, so no skill asks the user for a team.
- Cost: every repository needs a config entry before an agent can write a human ticket for it.
- Cost: the prompt line prefixes are a contract between Tau and the skill, so changing one changes
  both.

## See also

- [ADR 0075: Plan work as PR-sized slices in Linear](./0075-plan-work-as-pr-sized-slices-in-linear.md)
