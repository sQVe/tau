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
   The lead calls `architect` `open`, and a tab opens on `roles.architect.model`.
   The architect runs the start-slice design conversation with the user and writes the agent
   tickets in Linear. It sends the step 11 handover to the lead with `handover` `send` and ends its
   turn. The tab closes, and the architect lock is released.
2. Check the architect record and the lead's inbox.
   `.tau/architect/record.json` names the architect session file, and `.tau/architect/lock` is gone.
   The lead's inbox holds the step 11 handover.
3. Let the lead run the slice. Give it one user request that no skill covers.
   The lead calls `architect` `gate`, gets `specified`, and briefs a worker itself. The gate record
   is under `.tau/lead/gate/`.
   When a worker needs a design decision, the lead calls `architect` `ask`. A background terminal
   resumes the architect, which answers, updates the ticket, and sends the answer to the lead. The
   lead continues on that answer. The ask record is under `.tau/lead/ask/`.
4. Approve the publish step. The lead opens the pull request.

## End state

The slice has a pull request. The architect session is recorded and its lock is free. One gate
record and one ask record are under `.tau/lead/`. The lead's inbox holds the step 11 handover.
