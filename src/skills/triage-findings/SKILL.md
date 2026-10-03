---
name: triage-findings
description:
  Verify review findings or comments the user asked you to act on, fix the supported ones in scope,
  and report each one as Fixed, Not worth changing, Incorrect, or Blocked. Use it for "triage these
  findings", "fix these review comments", or "act on the findings I approved". Do not start it for
  findings the user has not approved, such as `code-review` output that waits for an answer.
---

# Triage findings

## When to use

Use this skill when the user asks you to act on review findings or comments. Do not start it on your
own for findings the user has not approved yet.

## Goal

Treat the findings as claims to verify, not a task list. Fix the supported findings that are worth
changing and within the requested scope. Explain the rest.

## Hard rules

- This skill alone does not authorize commits, pushes, ticket updates, or posted replies.
- Ask before expanding scope.
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
3. Fix the findings whose outcome is Fixed.
   - Weigh each fix against the branches, guards, and abstractions it adds.
   - Put defensive checks where untrusted input enters, not inside trusted code.
   - When a simpler change covers the concern, make that one instead.
4. Run the checks that cover your changes.
5. Report every finding under one heading per outcome, in this order: Fixed, Not worth changing,
   Incorrect, and Blocked. Write "None" under an empty heading.
   - Use one bullet per finding. Start it with a descriptive title or a short summary of the
     finding. Never use a finding number or ID in its place.
   - Make each bullet understandable without the original findings.
   - Include the file and line, the evidence, and what you changed or why you left it.
   - Under Blocked, also state what you need to continue.
6. End with a Checks section. It holds no findings. List the commands you ran and their results.
