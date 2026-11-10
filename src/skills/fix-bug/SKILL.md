---
name: fix-bug
description:
  Fix a reported defect at its root cause, test-first. Use it for "fix this bug", "this is broken",
  or "it regressed". It does not file tickets; the `tracker` skill does.
metadata:
  required-for: fixing a defect, regression, or broken behavior
---

# Fix bug

## When to use

Use this skill for a defect, a regression, or broken behavior. Use a bug ticket the user named.
Create one with the `tracker` skill only when the user asks. Do not file a ticket for every fix.

The procedure delegates to subagent workers, which need the `subagent` tools. Without them, carry
out each step yourself in the same order.

## Hard rules

- Write the regression test before the fix. It must fail for the diagnosed reason.
- Fix the root cause, not the symptom. Make the smallest change that does it.
- After two fixes based on the same diagnosis fail the same reproduction, write the shared premise
  down and test an observation that would differ if it were false. Do not write a third fix on it
  first. If the cause is now uncertain, stop for the user.
- Revert every change made for a hypothesis that the evidence refuted, so only lines the diagnosis
  supports ship.
- Stop for the user only when the root cause is uncertain, no reliable reproduction exists, or the
  fix changes behavior beyond the bug. Otherwise continue.

## Procedure

1. Reproduce. Find one command that fails on the bug the same way every run. If none exists, name
   the closest check and stop for the user.
2. Diagnose. Rank falsifiable hypotheses and test them in order. Name the root cause with file and
   line evidence. The manager sends a `scout` to do steps 1 and 2.
3. Fix test-first. Send a `worker` with the reproduction command and the root cause in its brief.
   Its acceptance criteria include "the reproduction command now passes" and the regression test
   name. The worker adds a regression test that fails for the diagnosed reason, then makes the
   smallest fix at the root cause. After two failed fixes on the same diagnosis, the worker reports
   back instead of writing a third fix on that premise. The manager then tests the premise as the
   hard rules say.
4. Verify. Rerun the reproduction and the affected tests, with `run_tests` for Vitest and the
   project's runner otherwise. The PR step runs the full check. Report the root cause, the
   regression test, and the check results.
