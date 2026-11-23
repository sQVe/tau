# Answer a handover question

## Who

The Tau user and a lead session that sent a handover.

## Goal

Unblock a handover session while the user is away.

## Test

By hand, because it needs two live Pi sessions and `hc`.

## Steps

1. From the lead session, call `handover` `prepare` and write the task to a file in the printed
   directory. Then call `handover` `start` with that file, a short title of the work as `name`, the
   checkout's absolute path as `folder`, and the checkout's space ID as `space` when reusing a
   space.
   A new tab opens, and its task text starts with
   `Handover sender: terminal <terminal>, session <sessionId>.`
2. In the new session, ask it to change a test that contradicts its brief.
   It calls `handover_question`, and its turn ends.
   `hc get <terminal> --json` on its terminal shows no `blocked` status.
3. The lead session shows `Handover question <questionId> from terminal ...` as an inbox message.

## End state

One open record is under `.tau/handoverQuestions/` in the asker's checkout, and the asker's terminal
has no open dialog.
