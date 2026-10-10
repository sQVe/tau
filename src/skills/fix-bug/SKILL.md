---
name: fix-bug
description:
  Fix a reported defect at its root cause, test-first. Use it for "fix this bug", "this is broken",
  "it regressed", or "why does this fail". It does not file tickets; the `tracker` skill does.
metadata:
  required-for:
    fixing a defect, regression, or broken behavior, including as a step in a larger task
---

# Fix bug

## When to use

Use this skill for a defect, a regression, or broken behavior. Use a bug ticket the user named.
Create one with the `tracker` skill only when the user asks. Do not file a ticket for every fix.

## Hard rules

- Write the regression test before the fix. It must fail for the diagnosed reason.
- Fix the root cause, not the symptom. Make the smallest change that does it.
- Stop for the user only when the root cause is uncertain, no reliable reproduction exists, or the
  fix changes behavior beyond the bug. Otherwise continue.

## Procedure

1. Reproduce. Find one command that fails on the bug the same way every run. If none exists, say so
   and name the closest check.
2. Diagnose. Rank falsifiable hypotheses and test them in order. Name the root cause with file and
   line evidence. The manager sends a `scout` to do steps 1 and 2.
3. Fix test-first. Send a `worker` with the reproduction command and the root cause in its brief.
   Its acceptance criteria include "the reproduction command now passes" and the regression test
   name. The worker adds a regression test that fails for the diagnosed reason, then makes the
   smallest fix at the root cause.
4. Verify. Rerun the reproduction, then the full check. Report the root cause, the regression test,
   and the check results.
