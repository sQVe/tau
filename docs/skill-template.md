---
name: <skill-name, the same as its directory>
description:
  <What the skill does, in one sentence.> Use it for "<a phrase a user says>" or "<another phrase>".
  <What it does not do, when another skill does it.>
metadata:
  required-for: <the action it must own>, including as a step in a larger task
---

<!-- Copy to skills/<skill-name>/SKILL.md and follow docs/skill-authoring.md. Delete metadata when
the agent never takes this action on its own. Delete sections the skill does not need, and this
comment. -->

# <Skill name>

## When to use

<When the skill applies, and what it needs first, such as an authenticated CLI.>

## Hard rules

- <A boundary that holds on every path, such as "Write nothing before the user approves the
  preview.">

## Procedure

1. <Gather the inputs. Name where each value comes from and what to do when one is missing.>
2. <Preview the decisions and every write, and ask for approval.>
3. <Make only the approved writes, with the skill's tool or one command. On a failure, stop and
   report what changed.>
4. <Report the result.>
