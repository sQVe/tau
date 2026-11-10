---
name: benchmark-checklist
description:
  Check evidence before measuring performance or reporting a speedup, regression, or comparison.
---

# Benchmark checklist

## When to use

Use this skill before you time anything, and before you report a speedup, a regression, or a
comparison between two versions. It applies inside and outside a pull request.

## Hard rules

- Never report a comparison without its timed region, run count, median, and spread.
- "Inconclusive" is a valid verdict. Do not rerun until a result looks like a win.
- A one-run ballpark is allowed only when the report labels it as one run with no measured spread.

## Procedure

1. Before you run anything, write down the claim and the timed region: the exact work the timer
   covers, and what it leaves out.
2. Check that the timed work is correct and that it actually ran. Compare its output with a known
   good result, and check that no cache, skip, or early exit replaced the work.
3. Before you compare, show that the harness can detect a change of the claimed size. For example,
   add a known delay of that size and check that the runs show it.
4. Keep the harness, inputs, machine, and settings fixed across every run you compare.
5. Run the versions in turns, A then B then A, for a fixed number of rounds. Report the median and
   the spread, such as the minimum and maximum, for each version.
6. When a change made only for speed shows no gain, or the result is inconclusive, drop the change.
   Keep the result in the report.
7. Write the result with the [report template](report.md). Put it in the commit message, pull
   request, or reply that makes the claim.
