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
the user's own work, as the [code-review skill](../code-review/SKILL.md) defines it. Do not start it
on your own for findings on someone else's work, or after a request for a read-only review.

## Goal

Treat the findings as claims to verify, not a task list. Fix the supported findings that are worth
changing and within the requested scope. Explain the rest.

## Hard rules

- When the workflow that started this skill commits, such as `pr`, commit the fixes on its feature
  branch with the [commit skill](../commit/SKILL.md). Otherwise leave them uncommitted. Approval to
  fix never authorizes pushes or posted replies to people. Linear writes follow
  [Hard rules](../tracker/SKILL.md#hard-rules).
- Ask before expanding scope. Mark a finding Blocked when its fix needs a decision about scope,
  intended product behavior, or policy, or when you cannot settle a disputed claim against the code.
  Fixing a defect so the code does what the task intends needs no decision. Make the safe fixes
  first, then ask about the Blocked findings.
- Making the reviewer happy is not a reason to change code.

## Procedure

1. Verify each finding against the code before you act on it.
   - Check the project rules and callers that apply.
   - For a change-specific finding, inspect the actual diff. Separate problems the change introduced
     from existing ones.
   - Treat a behavior finding as supported only when you can name the input, state, or caller that
     reaches it.
2. Give each finding one outcome:
   - Fixed: supported, worth changing, and within scope.
   - Not worth changing: valid, but the fix costs more than the concern.
   - Incorrect: the code does not support the finding.
   - Blocked: you cannot settle the finding against the code. Or it is valid, but you cannot make
     the change without access, a decision, or information you do not have.
   - On the user's own work, a supported finding that is worth changing is Fixed without asking when
     behavior stays the same, every caller of the changed code is in the repository, and checks
     cover the change. Moving a helper between modules and updating its callers in the repository
     needs no question.
   - Hold a supported, worthwhile finding for the question in step 5 when its fix needs a design
     decision of its own, or when its behavior is uncertain. Hold it too when it edits files that
     another slice in the stack owns, or when code outside the repository uses the contract it
     changes, such as a published API or CLI, a config file users own, or saved data.
   - Hold the findings for step 5 when their fixes together would grow the change a lot. Take about
     100 added lines or about 3 more files as guidance, not a cutoff. File count alone does not
     decide.
   - The `local` and `restructure` labels of code-quality are the finder's estimate. Decide by the
     rules above, not by the label.
3. Fix the findings whose outcome is Fixed.
   - Weigh each fix against the branches, guards, and abstractions it adds.
   - Put defensive checks where untrusted input enters, not inside trusted code.
   - When a simpler change covers the concern, make that one instead.
   - For a surviving mutant, follow the mutation step of the [tdd skill](../tdd/SKILL.md).
4. Run the checks that cover your changes.
5. Report every finding under one heading per outcome, in this order: Fixed, Not worth changing,
   Incorrect, and Blocked. Write "None" under an empty heading.
   - Use one bullet per finding. Start it with a descriptive title or a short summary of the
     finding. Never use a finding number or ID in its place.
   - Make each bullet understandable without the original findings.
   - Include the file and line, the evidence, and what you changed or why you left it.
   - Under Blocked, also state what you need to continue.
   - After the safe fixes, ask about the held findings in one `ask_user_question` call, with one
     question per finding: fix it in this branch, or file a follow-up ticket. Give the size and risk
     of each fix. Recommend fixing it in this branch, except when code outside the repository uses
     the contract it changes; then recommend the follow-up ticket. When the held findings exceed the
     tool's question limit, ask the rest in as many further calls as the limit requires.
   - On this branch, fix it, run step 4 again, and report it under Fixed. On follow-up, file the
     ticket with acceptance criteria with the [tracker skill](../tracker/SKILL.md). Keep the finding
     under Blocked, with the ticket identifier in place of what you need to continue.
6. End with a Checks section. It holds no findings. List the commands you ran and their results.
