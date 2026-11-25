# Post a review

Run this only when the user asks to comment on another person's pull request.

Before step 1, resolve the PR's host, owner, name, and number. Pin the reviewed diff to the head SHA
from the review's capture, so every draft anchors to the head the reviewer read. Read the PR diff at
that head and check that the reviewed content comes from it. When the reviewed content is not in
that diff, stop and require a fresh review of the PR diff. When the remote head differs from that
head, stop and offer the user a fresh review of the new head. Never post drafts made against an
older head.

1. Filter the findings with one `checker` worker.
   - Take the reviewer's model from the reviewer's launch result.
   - Launch the worker with `model` set to another model from the `subagent` tool's list. The user's
     request to comment approves this added worker and its model. Say so when you launch the worker.
   - Check that the launch result shows a model other than the reviewer's. When the tool lists no
     other model, or the launch is rejected or shows the same model, ask with `ask_user_question`
     which model to use.
   - Give the worker the findings and one question: which of these would the author want to hear,
     given a concrete failure or a reproduction? Keep those.
   - Put a small item with no failure in the body list, or drop it.
   - When nothing is kept, post nothing and tell the user. Never post a finding the filter did not
     check.
2. Draft the body and one inline comment per anchorable kept finding, following
   [review comments](../shared/review-comments.md). Anchor each comment to a changed line of the PR
   diff at the pinned head. Put each other kept finding in the body list.
3. Save the body, the pinned head SHA, and the comments as `$dir/review.json`. Show that file as one
   `ask_user_question` preview, under the tracker skill's
   [Hard rules](../tracker/SKILL.md#hard-rules) for GitHub reviews. Show the destination (host,
   owner/name, PR number) and each anchor's path, line, side, and head SHA, as [pr](../pr/SKILL.md)
   step 8 previews a review. Step 4 posts that exact file. A change after approval needs a new
   preview.
4. Post one pending review as [pr](../pr/SKILL.md) step 12 does, with these differences:
   - The PR belongs to another person.
   - `review.json` lives in the review's `$dir`.
   - Leave `event` out, so GitHub keeps the review pending. Still send the approved `body`.
   - Report the review URL. Tell the user to submit it in GitHub. Never submit it.
   - When the head moved, stop as the pinned head rule says, and offer a fresh review of the new
     head. Do not preview the same drafts again.
