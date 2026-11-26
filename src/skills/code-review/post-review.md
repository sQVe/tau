# Post a review

Run this only when the user asks to comment on another person's pull request. Judge ownership from
the destination pull request, not from the review's capture. Use the destination pull request's
ownership for the tracker skill's approval rule.

Before step 1, resolve the PR's host, owner, name, and number. Pin the reviewed endpoint from the
capture target: the target `to` for a range, and the capture `head` for every other kind. Read the
PR diff at that endpoint and check that the reviewed content comes from it. When the reviewed
content is not in that diff, stop and require a fresh review of the PR diff. When the remote head
differs from that endpoint, stop and offer the user a fresh review of the new head. Never post
drafts made against an older endpoint.

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
   diff at the pinned endpoint. Put each other kept finding in the body list.
3. Call `pr` `prepare` once and use its directory as `$prdir`. Save the body, the pinned endpoint,
   and the comments as `$prdir/review.json`. Dry run with `kind: 'review'`, `repository`, `pr`, and
   `directory`, fix every finding, and dry run again. Show that file as one `ask_user_question`
   preview, under the tracker skill's [Hard rules](../tracker/SKILL.md#hard-rules) for GitHub
   reviews. Show the destination (host, owner/name, PR number) and each anchor's path, line, side,
   and pinned endpoint, as [pr](../pr/SKILL.md) step 8 previews a review. Step 4 publishes that
   exact file. A change after approval needs a new preview.
4. Publish one pending review with `pr` `publish`, `kind: 'review'`, the dry run's `token`,
   `repository`, `pr`, and `directory`, as [pr](../pr/SKILL.md) step 12 does, with these
   differences:
   - Leave `event` out, so GitHub keeps the review pending. Still send the approved `body`.
   - Report the returned `url`. Tell the user to submit it in GitHub. Never submit it.
   - When the remote head differs from the pinned endpoint, stop and offer a fresh review of the new
     head, as the pin rule above says. Do not preview the same drafts again.
