# Vision

- Status: Active

## The idea

Tau is our daily configuration for [Pi](https://github.com/badlogic/pi-mono). It sets the tools we
rely on, the way we want the agent to write, and the steps we require before work counts as done.

Pi runs the agent and its tools. Tau decides which tools are present, how the agent behaves, and
which steps it must prove. Tau is one package. Install it and Pi is ready.

This is the goal. Tau is under active development, so parts of it are not there yet.

## Principles

- One install. Everything a Tau skill depends on ships inside Tau.
- Prefer a maintained package over our own code. Write our own only when the behavior is part of
  Tau's flow and no package fits.
- Enforce with code where it matters. Instructions guide; guards and evidence checks decide.
- Few concepts, with clear meanings and firm rules. The same process every time.
- Use models that fit the work to reduce cost and time without sacrificing required quality. Every
  model Tau selects must be user-configurable.
- Hand off to the tool that already does the job. A browser task goes to Claude Code in a
  [herdr](https://herdr.dev) pane, not to a second browser stack in Pi.

## In scope

- bundled tools: web search and fetch, user questions, subagents.
- model selection for Tau's tools and subagents, including delegation to cheaper models.
- agent behavior: writing rules, prompt snippets, skills for commit, brainstorm, bug fixing, and
  pull requests.
- gates with evidence: confirmed commits, comment review, and test-driven development when a task
  opts in.
- Pi user interface pieces those flows need, such as overlays and footers.

## Out of scope

- Pi's own runtime, SDK, and terminal interface.
- safety guards that other packages already provide, such as destructive command blocking.
- tools that another agent runs better than Pi. Tau hands those off.

## See also

- [Development](./development.md)
- [Documentation index](./README.md)
