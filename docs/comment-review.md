# Comment review

The `commit` tool reviews comments before opening commit approval. It uses a separate call to the
session's model with the session's credentials. That call adds latency and model usage; it has no
tools and cannot edit files.

## What gets reviewed

The reviewer receives the staged diff, the before-and-after versions of affected files, and staged
`AGENTS.md` files from their ancestor directories. It checks changed comments and nearby comments
whose meaning changes with the code. It does not audit unrelated code.

Useful explanations of constraints, invariants, workarounds, and decisions should stay. Concrete
inaccuracies and clear comment-policy violations block approval. Suggestions to explain a missing
constraint are advisory. The policy lives in
[commentReview.ts](../src/extensions/commit/commentReview.ts).

## Respond to findings

1. Call `commit` with the usual `groups` array, each carrying its file list, subject, and body.
2. If it returns blocking findings, fix them and call it again. For a disputed finding, supply
   `commentDispute` on the group the finding belongs to, with concrete evidence. This requests
   another review; it cannot waive a finding. Approval and the commit result retain the dispute
   evidence and preceding findings, even when the new review passes.
3. After two automatic returns for fixes, unresolved findings appear in the approval overlay. Choose
   **Read comment review** to inspect the full report. The report scrolls with arrow keys and
   Home/End; Escape returns to approval and Ctrl+C aborts the commit.
4. Choose **Return for fixes or retry**, skip the group, abort, or explicitly choose **Waive comment
   review and commit**. Ordinary approval cannot waive a blocking or failed review.

Advisory findings allow ordinary approval and appear in the tool result. A waiver is recorded in the
tool result with the report, reviewed Git tree, and policy fingerprint.

## Review validity

Tau reuses the last successful review for an unchanged group, staged tree, policy, model, and
dispute within the extension instance, retaining up to 32 recent groups. Skip, abort, cancellation,
and explicit retry reset the group’s correction counter. Correction and hook retries retain it.
Reloading extensions resets the cache and counters. Changing staged content requires a fresh review.
If content or HEAD changes while approval is open, call `commit` again.

A hook that rewrites approved content causes Tau to undo the new commit while retaining the hook's
changes. The next commit attempt reviews those changes. Format files before committing to avoid this
extra round trip.

## Failed reviews

Missing model credentials, invalid responses, oversized input, and provider failures remain visible
as failed reviews. Retry or explicitly waive them; they never count as passing reviews. Model calls
share a two-minute timeout across the initial response and one retry for invalid JSON or findings. A
surrounding JSON code fence is accepted; findings must still cite supplied source files and valid
lines. Policy-only files are not review targets.

Input is limited to 1,000,000 characters and individual blobs to 400,000 bytes. This accommodates
ordinary lockfile updates with complete before-and-after content. Larger input still requires
splitting the commit or an explicit waiver; Tau never silently omits oversized source files.
Provider context limits can be lower than Tau’s input limit.

The gate enforces the review workflow. Whether a comment is useful or accurate remains a model
judgment, and the reviewer must avoid findings it cannot substantiate from the supplied context.
Binary files identified by Git are excluded from source context.

## See also

- [Development](./development.md)
