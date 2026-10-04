# Tool authoring

Use this guide when you write or change a Tau tool that a skill calls. Then go through the
checklist.

## Place the tool

- Put the tool in its own extension under `src/extensions/<feature>/`, and call the extension from
  `src/tau.ts`.
- Register a tool that serves one skill with `defaultActive: false`. Add the skill name and the tool
  name to the skill tools map, the third argument of `tauSkillsExtension` in `src/tau.ts`. Running
  `/<name>`, or a `read` of the skill's `SKILL.md`, then turns the tool on.
- When two skills need the same mechanics, share one tool or module. Never copy the mechanics into
  another tool or skill. Create a scratch directory inside an ignored `.tau/` with
  `src/tauDirectory.ts`.

## Split the work between skill and tool

A skill's tool owns the mechanics. The skill keeps the judgment.

- Put the call contract in the tool's description: its parameters, results, and errors. The skill
  says when to call it and what to do with the result, without repeating the contract.
- Split reading from writing. A read returns the current state and the exact writes it plans. An
  apply takes that plan and refuses when the state has changed since the read.

## Checklist

Writes:

- [ ] The tool asks with `ctx.ui.confirm` before a write outside the worktree, such as a Linear
      ticket, a GitHub change, or a file outside the checkout. A write to a GitHub bot needs no
      confirm; see [ADR 0086](./adr/0086-post-to-github-bots-without-a-confirm.md).
- [ ] The confirm shows the exact writes the tool will make, so the user sees what they approve.
- [ ] The tool writes nothing when the user declines or when the session has no UI.
- [ ] A retry applies only the writes that are missing, and identifies each one by a saved ID, not
      by a title.
- [ ] A partial failure reports what was applied and what was not.

Parsing:

- [ ] The tool parses command output once, at the boundary, and fails with an error that names the
      bad output.

Tests:

- [ ] Tests use a fake CLI for normal, missing, and malformed output.
- [ ] Tests cover a declined confirmation, a session without UI, and a retry after a partial
      failure.
