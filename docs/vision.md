# Vision

- Status: Active

## The idea

Tau is our daily configuration for [Pi](https://github.com/badlogic/pi-mono). It sets the tools we
rely on, the way we want the agent to write, and the steps we require before work counts as done.

Pi runs the agent and its tools. Tau decides which tools are present, how the agent behaves, and
which steps it must prove. Tau is one package. Install it and Pi is ready.

This is the goal. Tau is under active development, so parts of it are not there yet.

## Principles

- One install. Everything a Tau skill depends on ships in Tau or loads in the worker that uses it.
- Prefer a maintained package over our own code. Write our own only when the behavior is part of
  Tau's flow and no package fits.
- Enforce with code where it matters. Instructions guide; guards and evidence checks decide.
- Few concepts, with clear meanings and firm rules. The same process every time.
- Use models that fit the work to reduce cost and time without sacrificing required quality. Every
  model Tau selects must be user-configurable.
- Hand off to the tool that already does the job. Browser work goes to Tau's `browser` worker, which
  loads the browser package only in workers, so the manager does not carry the browser.

## How Tau fits together

The user decides what to build, approves publication, and merges the PR. The manager plans the work,
joins the evidence, and publishes. Workers build, review, and test inside one assignment.

The acceptance item is the spine: every stage writes it, carries it forward, or checks evidence
against it. The stages below connect an idea to a merged PR. The owning skills hold the procedure;
[start-slice](../src/skills/start-slice/SKILL.md) owns the order after the workers finish.

| Stage and owner                                                                    | Acceptance item and artifact passed onward                                                                                                  |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Design: [brainstorm](../src/skills/brainstorm/SKILL.md)                            | Turns the agreed outcome into acceptance criteria in `design.md`, the input to slice planning.                                              |
| Slice tickets: [slice](../src/skills/slice/SKILL.md)                               | Maps each design criterion to a slice ticket with acceptance items and expected checks.                                                     |
| Agent tickets and worker launch: [start-slice](../src/skills/start-slice/SKILL.md) | Maps each slice item to an agent ticket; workers receive its acceptance items and return a worker report with check evidence.               |
| Review: [code-review](../src/skills/code-review/SKILL.md)                          | Checks the change against the ticket's intent and acceptance evidence; the review `report.md` carries findings and evidence into the audit. |
| Slice audit: [finish-slice](../src/skills/finish-slice/SKILL.md)                   | Gives every slice and agent acceptance item a verdict in `finish.md`, carrying unmet items forward.                                         |
| QA: the `qa` worker                                                                | Tests user-visible acceptance items and returns a QA report with observations and gaps for publication.                                     |
| PR: [pr](../src/skills/pr/SKILL.md)                                                | Joins the reports and check results in the PR; unmet or unchecked acceptance items remain required actions.                                 |
| Feedback rounds: [pr-feedback](../src/skills/pr-feedback/SKILL.md)                 | Checks feedback against the promised behavior and records fixes and check results on the PR before the user merges it.                      |

When they run, [prune-comments](../src/skills/prune-comments/SKILL.md) and
[code-quality](../src/skills/code-quality/SKILL.md) precede code-review. Review scope is `first` or
`fix`; review mode is `fast` or `deep`. QA runs only for user-visible behavior. It is a worker, not
a skill. Its launching skill owns when it runs. After the user merges the PR, Linear's GitHub
integration moves the linked, completed slice to Done.

Other entry routes skip design and slice planning and join review and the PR:

- Small edits: the manager makes and checks small local edits itself. Its own edit needs a fast
  code-review when it is not small or changes policy text, such as a guide, an ADR, or project
  rules.
- Bug fixes: [fix-bug](../src/skills/fix-bug/SKILL.md) turns the reproduction and regression test
  into acceptance criteria and returns the fix with check results.

Utility skills support the stages rather than adding stages:

- [commit](../src/skills/commit/SKILL.md): logical Git commits;
  [stack](../src/skills/stack/SKILL.md): dependent branches and PRs;
  [worktree](../src/skills/worktree/SKILL.md): separate checkouts.
- [handover](../src/skills/handover/SKILL.md): work passed to another manager;
  [update-branch](../src/skills/update-branch/SKILL.md): rebases and conflicts;
  [tracker](../src/skills/tracker/SKILL.md): Linear tickets.
- [tdd](../src/skills/tdd/SKILL.md): test-first changes;
  [triage-findings](../src/skills/triage-findings/SKILL.md): checked findings and fixes;
  [benchmark-checklist](../src/skills/benchmark-checklist/SKILL.md): performance evidence.
- [diagram](../src/skills/diagram/SKILL.md): system connections; [bro](../src/skills/bro/SKILL.md):
  plain-language explanations; [retrospective](../src/skills/retrospective/SKILL.md): diagnosis of
  completed work.

## In scope

- bundled tools: web search and fetch, user questions, subagents.
- model selection for Tau's tools and subagents, including delegation to cheaper models.
- agent behavior: writing rules, prompt snippets, skills for commit, brainstorm, bug fixing, and
  pull requests.
- planning and delivery: slices and Linear tickets, stacked branches, full checks.
- gates with evidence: commits through installed Git hooks.
- test-driven development guided by truthful test outcomes and nonblocking hints.
- Pi user interface pieces those flows need, such as overlays and footers.

## Out of scope

- Pi's own runtime, SDK, and terminal interface.
- safety guards that other packages already provide, such as destructive command blocking.
- tools that another agent runs better than Pi. Tau hands those off.
