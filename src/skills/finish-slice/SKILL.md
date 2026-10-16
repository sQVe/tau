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

- Write to Linear as the tracker skill's [Hard rules](../tracker/SKILL.md#hard-rules) says. Write
  only the audit comment and agent tickets inside the slice's outcome. Do not write to the container
  or other slices, and do not change any status.
- Ask every question with the `ask_user_question` tool.
- Do not run the full check. The pr skill owns it.
- Worker reports and reviews only feed evidence in. This skill gives the verdict.
- Verdicts are:
  - met: a passing test, a command result, or demonstrated behavior shows it.
  - deferred: the check can run only after deployment, as the pr skill defines it.
  - not met: the evidence shows the item fails.
  - not run: any other check that did not run. It makes draft the suggested PR status.

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
   - First, stop and report when `git branch --show-current` differs from the branch in `start.md`,
     or from the slice's `branchName` when `start.md` names none. Stop and report too when
     `git status --porcelain` prints anything. The audit names one commit, so the checks must run on
     that commit's checkout.
   - Evidence must cover the audited commit. A check or report from before the last change to what
     it covers does not count. Rerun it, or mark the item not run.
   - Save the real output of each check you run in `$slicedir`, in a file named for the check, never
     a summary. Cite that path as the evidence.

5. If any item is not met, stop the flow before any PR. When the fix fits inside the slice outcome,
   create an agent ticket for it as "Changes after the start" in the start-slice skill says.
   Otherwise report that the fix needs a new slice.

6. Find an earlier audit comment before you write a new one. Run the tracker skill's comment list
   command on the slice, even when `finish.md` records a comment ID. Pick the comment with the
   recorded ID, or with none recorded, the comment whose first line is `# Slice audit: <slice>`.
   Read its saved text from that list.

7. Write `$slicedir/finish.md` from the [audit template](audit.md). Name the audited commit with the
   full SHA from `git rev-parse HEAD`, and keep the earlier comment's ID.

8. Post the content of `finish.md` with the tracker skill's comment commands. Update the earlier
   comment when one exists, and never add a second one. After adding a new comment, record its ID in
   `finish.md` at once.

9. Report the verdict counts, the comment link, and whether the suggested PR status is ready or
   draft, or the PR is blocked. When you updated an earlier comment, name each edit made in Linear
   that the new audit dropped.
