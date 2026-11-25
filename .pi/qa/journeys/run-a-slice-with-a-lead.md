# Run a slice with a lead

## Who

The Tau user, a lead session in a new worktree, and the architect the lead opens. The lead runs on
DeepSeek, and the architect runs on Opus.

## Goal

Take a slice from the first conversation to a pull request, with design on the architect and
orchestration on the lead.

## Test

By hand, because it needs live Opus and DeepSeek sessions and Linear.

## Steps

1. Open a worktree and tell its lead to start a slice, such as `start ME-1234`.
   The lead calls `architect` `open`, and the architect opens in a pane to the right of the lead in
   the lead's tab on `roles.architect.model`.
   The architect runs the start-slice design conversation with the user and writes the agent
   tickets in Linear. While it runs, its pane shows no plan list. It sends the step 11 handover to
   the lead with `handover` `send` and ends its turn. Only the architect's pane closes, and the
   architect lock is released.
2. Let the original lead continue the started slice from the handover. Do not ask it to start the
   slice again.
   The lead calls `plan` with three or more steps, at most one `in_progress`. A list above the
   lead's editor shows the steps with their status marks and a header counter such as
   `─── Plan · 1/3 ───`.
3. Let a worker report and the lead accept it.
   The lead calls `plan` again. The finished step shows a green check mark with dim struck-through
   text, and the next step shows an accent dot with bold text. The header counter rises.
4. Before the fresh lead session of the later step, let the original lead finish its plan.
   The list disappears from the original lead. The chat shows the last `plan` result, such as
   `Plan: 5 of 5 completed.`
5. Check the architect record and the lead's inbox.
   `.tau/architect/record.json` names the architect session file, and `.tau/architect/lock` is gone.
   The lead's inbox holds the step 11 handover.
6. Let the lead run the slice. Give it one user request that no skill covers.
   The lead calls `architect` `gate`, gets `specified`, and briefs a worker itself. The gate record
   is under `.tau/lead/gate/`.
   When a worker needs a design decision, the lead calls `architect` `ask`. A background terminal
   resumes the architect, which answers, updates the ticket, and sends the answer to the lead. The
   lead continues on that answer. The ask record is under `.tau/lead/ask/`.
7. In a test slice on the user's own branch, give the lead supported P1, P2, and P3 findings after
   the fix review. Check that it delegates the P1 fix and files one ticket for each P2 and P3
   without a disposition dialog. Check that `triage.md` names the written tickets and why each
   can wait.
8. In a separate test case, leave a ship-blocking first-review finding outside the fix review's
   changed paths. Give the fix review no findings. The lead checks the earlier claim against
   current code and delegates its P1 fix. Repeat with a fix that cannot be checked. The preview
   shows a required action and suggests draft.
9. Repeat the decision with a compatibility choice that needs approval. Decline the approval.
   Check that the lead makes no fix or ticket write for that finding and reports why it is blocked.
10. In a test tracker, fail a selected follow-up write after another ticket was written. Check
    that the lead keeps the written ticket and reports the failed write as Blocked. The lead does
    not list the unfiled follow-up as accepted or retry past the tracker skill's stop rule.
11. Start a fresh lead session on the successful test branch without resuming the conversation.
    Ask for a PR preview. Use the saved review directories if the session needs paths, without
    supplying findings or ticket IDs. Check that it reads `triage.md` and lists each saved ticket
    once as `Related to`. The entries appear under Verification or in the template's follow-up slot.
12. Approve publication for the successful test slice. The lead opens the pull request.

## End state

The slice has a pull request. The architect session is recorded and its lock is free. One gate
record and one ask record are under `.tau/lead/`. The lead's inbox holds the step 11 handover.
