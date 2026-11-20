---
name: triage-findings
description:
  Verify review findings or comments the user asked you to act on, fix the supported ones in scope,
  and report each one as Fixed, Not worth changing, Incorrect, or Blocked. Use it for "triage these
  findings", "fix these review comments", or "act on the findings I approved". `code-review`, `pr`,
  and `start-slice` also start it after a review of the user's own work.
---

# Triage findings

## When to use

Use this skill when the user asks you to act on review findings or comments, or after a review of
the user's own work. Read `ownership` from the review capture or PR evidence that started this
skill. Treat the work as the user's own only when `ownership.status` is `own`, following the
[code-review ownership rule](../code-review/SKILL.md#hard-rules).

## Goal

Treat findings as claims to verify, not a task list. Choose which supported findings to fix or file.
Explain what stays open.

## Hard rules

- Ask before acting on work that is not the user's own, unless the user already approved that
  action. Do not act after a read-only or no-changes request unless the user approves changing that
  scope. Ask when a rule or skill requires approval, such as for a compatibility choice.
- Approval to fix never authorizes a push or a reply to a person. It does not authorize filing on
  work that is not the user's own.
- Ask before expanding scope or deciding intended product behavior or policy. Fixing a defect so the
  code does what the task intends needs no decision.
- When the calling workflow commits, such as `pr`, commit the fixes on its feature branch with the
  [commit skill](../commit/SKILL.md). Otherwise leave them uncommitted.
- Making the reviewer happy is not a reason to change code.

## Procedure

1. Verify each finding against the current code before you act on it.
   - Check the project rules and callers that apply. Inspect the diff for a change-specific finding.
     Separate problems the change introduced from existing ones.
   - Treat a behavior finding as supported only when you can name the input, state, or caller that
     reaches it.
   - When the first review and fix review both report the same problem, combine the claims and keep
     both report references. A path outside the fix review or an omission from its report does not
     settle a first-review finding.
2. Select an action for each verified finding.
   - Mark a claim the code disproves Incorrect. Mark a valid finding whose fix costs more than the
     concern Not worth changing. Mark an unresolved claim Blocked. Do not act on it.
   - After the lead's one fix review, use the [post-fix selection rule](#after-the-leads-fix-review)
     for supported, worthwhile findings.
   - In ordinary triage, hold a supported, worthwhile finding when its fix needs a design choice,
     its intended behavior is uncertain, it touches files another slice owns, or it changes a
     contract used outside the repository. Hold the findings too when their fixes together would
     grow the change a lot. About 100 added lines or three more files are guidance, not cutoffs.
   - For other supported, worthwhile findings in ordinary triage, select an in-branch fix if it
     stays in scope. A helper move that keeps behavior unchanged and updates every caller in the
     repository needs no question.
   - Do not use the code-quality finder's `local` or `restructure` label to decide the action.
3. Carry out the selected actions. Apply the approval rules above before each action. If an approval
   is declined or an action cannot proceed, keep the finding Blocked and say why.
   - Send the in-branch fixes to a `worker`. After the lead's one fix review, send them in one batch
     and do not start another routine fix review. The lead checks the report and makes no edits
     itself.
   - Prefer a simpler fix when it covers the concern. Put defensive checks where untrusted input
     enters. For a surviving mutant, follow the mutation step of the [tdd skill](../tdd/SKILL.md).
   - Have the worker run the checks that cover the changes. Mark a fix Fixed only after its checks
     pass.
   - File selected follow-ups with acceptance criteria through the
     [tracker skill](../tracker/SKILL.md). Keep each written ticket's identifier and URL. On partial
     failure, follow the tracker skill's stop and retry rules. Do not treat an unfiled follow-up as
     accepted.
   - After the safe fixes, ask about the findings held in ordinary triage. Use one
     `ask_user_question` question per finding. Offer an in-branch fix or a follow-up. Give the size
     and risk. Recommend the in-branch fix unless it changes a contract used outside the repository.
     Split the questions only when the tool limit requires it. Carry out approved actions with the
     same worker, check, and filing rules above.
4. Report every finding under Fixed, Not worth changing, Incorrect, or Blocked, in that order. Write
   "None" under an empty heading. Give one bullet per finding with a short title, file and line,
   evidence, and what you changed or why you left it.
   - Under Blocked, state what would resolve the finding. For a filed follow-up, link its ticket and
     say why the finding can wait. Mark it as an accepted follow-up only when waiting waives no
     promised behavior or mandatory check. A follow-up is not Fixed.
   - If a finding must be fixed before the PR is ready and it could not be fixed or checked, mark it
     as a PR required action and name its completion condition.
   - After the lead's one fix review, save the outcomes in `triage.md` beside the fix review's
     `report.md`. For an empty fix capture, save it beside the first review's report instead. Keep
     each finding's original report reference, priority if assigned, evidence, and outcome. Record
     any accepted follow-up with its link and reason for waiting. Record each required action with
     its completion condition. Do not change the capture or repost the review report.
   - End with a Checks section. List the commands you ran and their results. Include no findings in
     that section.

### After the lead's fix review

Assign a priority only to supported, worthwhile findings. Use the impact of shipping this branch,
not the size of the fix or the reviewer's confidence. Select the action by priority:

- P1: shipping would leave promised behavior unmet, a mandatory check unsatisfied, or a material
  risk that must be fixed before the PR is ready. Select an in-branch fix.
- P2: the finding has a concrete cost, but can wait without waiving promised behavior or a mandatory
  check. Select one follow-up ticket for the finding.
- P3: the finding has a smaller, local cost and meets the same condition for waiting. Select one
  follow-up ticket for the finding.

Do not ask the user to choose the action. Ask only for an approval required by the hard rules.
