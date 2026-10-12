---
name: finish-slice
description:
  Audit a finished slice against the acceptance items of the slice and its agent tickets. Gives each
  item a verdict, writes `finish.md`, and posts it as one comment on the slice ticket. Use it for
  "finish the slice", "audit ENG-123", or "check the slice before the PR". It does not run the full
  check or open the PR.
metadata:
  required-for:
    auditing a finished slice against its acceptance criteria before its PR, including as a step in
    a larger task
---

# Finish slice

## When to use

Use this skill when every agent ticket of a slice is done, before its PR. The
[start-slice skill](../start-slice/SKILL.md) runs it before the [pr skill](../pr/SKILL.md). The user
can also run it alone, in the same session or a later one. It needs the `linear` CLI authenticated
for the workspace.

## Hard rules

- Write to Linear only after the user approves a preview that shows the write, and follow the
  [tracker skill](../tracker/SKILL.md). Write only the audit comment and approved agent tickets. Do
  not write to the container or other slices, and do not change any status.
- Ask every question with the `ask_user_question` tool.
- Do not run the full check. The pr skill owns it.
- Worker reports and reviews only feed evidence in. This skill gives the verdict.
- Verdicts are:
  - met: a passing test, a command result, or demonstrated behavior shows it.
  - deferred: the check can run only after deployment, as the pr skill defines it.
  - not met: the evidence shows the item fails.
  - not run: any other check that did not run. It makes the PR a draft.

## Procedure

1. Pick the slice. If the user names none, use the one slice the conversation names. Ask with
   `ask_user_question` when none or several fit.

2. Find the draft. Call the `slice` tool's `prepare` action with the slice identifier in lower case,
   such as `me-537`. Use the returned `directory` as `$slicedir`. `finish.md` goes next to
   `start.md` there.

3. Read the slice with `linear issue view <slice> --json --no-pager`, and its agent tickets as
   children, as step 3 of the start-slice skill does. Collect every `## Acceptance` item of the
   slice and of each agent ticket. If there are none at all, stop and report that.

4. Give each item a verdict with its evidence. Run the checks that are cheap and missing, except the
   full check.
   - Evidence must cover the audited commit. A check or report from before the last change to what
     it covers does not count. Rerun it, or mark the item not run.
   - Save the real output of each check you run in `$slicedir`, in a file named for the check, never
     a summary. Cite that path as the evidence.

5. If any item is not met, stop the flow before any PR. Propose an agent ticket inside the slice
   outcome, as "Changes after the start" in the start-slice skill says. Create it only after the
   user approves a preview, as the tracker skill says.

6. Write `$slicedir/finish.md` from the [audit template](audit.md). Name the audited commit with the
   full SHA from `git rev-parse HEAD`.

7. Preview the comment, which is the content of `finish.md`, and ask the user to approve it.

8. Post it on the slice ticket with the tracker skill's comment commands, and record the comment ID
   in `finish.md` at once.
   - On a rerun, update the earlier comment instead of adding one. Use the recorded ID. If none is
     recorded, run the comment list command and pick the comment whose first line is the template's
     first line.
   - Before you overwrite, read the saved comment. The tracker copy wins over a working copy the
     user has not approved.

9. Report the verdict counts, the comment link, and whether the PR is ready, a draft, or blocked.
