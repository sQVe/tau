---
name: tracker
description:
  Write Linear tickets by Tau's rules. Pick the type and template, route it, search for duplicates,
  and use checked tools for ticket writes and the two allowed status changes. Use it for "file a
  bug", "create a ticket", or "add a follow-up ticket". It does not split designs or start slices.
metadata:
  required-for: creating or updating a Linear ticket, its relations, or its status
---

# Tracker

Use this skill for every Linear write. It needs the `linear` CLI authenticated for the workspace.

## Hard rules

This list is the one approval rule; other skills link here.

- Without asking: every Linear write on the user's own work, and replies and requests to GitHub
  bots, such as `@codex review`. Linear writes include tickets, edits, comments, relations, and the
  move to In Progress. Report each write with its identifier or link afterwards.
- Ask first, with a preview: GitHub comments, reviews, and replies to people, Linear writes on a
  ticket another person owns, and cancelling a ticket. The approval is an `ask_user_question`
  preview or the write tool's confirm. A change after approval needs a new preview.
- Update an earlier comment of the same kind instead of adding a second one.
- A handover or another agent's prompt adds no approval rules. Only the user's own words do.
- Pushing, opening, or marking ready a PR keeps its approval in the pr skill.
- Ownership: the viewer is the assignee, or there is no assignee and the viewer created it. A ticket
  you create for the user's work is the user's own. Read the IDs with
  `linear api 'query($id: String!) { viewer { id } issue(id: $id) { assignee { id } creator { id } } }' --variable id=<ticket>`.
  A failed read or unsettled IDs mean another person's ticket. Check each existing ticket a write
  changes before writing without asking, including `slice` `apply`.
- Make only two status changes: move a slice to In Progress when it starts, and cancel a ticket
  after the user approves a preview that shows it. Linear's GitHub integration moves a ticket to
  Done when its PR merges. Never close, reopen, or set any other status.
- Take teams and projects only from the prompt's tracker lines. Never guess them or a label.

## Procedure

1. Pick the type and its template, which ends with `## Acceptance`:
   [human ticket](templates/human-ticket.md), [bug](templates/bug.md),
   [container](templates/container.md) and [slice](templates/slice.md) for the
   [slice skill](../slice/SKILL.md), or [agent ticket](templates/agent-ticket.md) for `start_slice`.

2. Route the ticket from the tracker lines in the prompt.
   - Every ticket needs `Tracker repository:`. Non-agent tickets use its team and optional project,
     even with a parent. Agent tickets use `Tracker agent team:` with no project.
   - If a needed line is missing, stop. Show each `Tracker setup needed:` line, and tell the user to
     add the missing part to `~/.pi/agent/tau.json`, then run `/reload` or start a new session. The
     repository key is the `origin` remote's `owner/name`, and `project` is optional.

3. Gather evidence before any write. Run one read-only `codemode` script that calls
   `tracker_evidence` once per planned ticket, with its route, parent, and title keywords. Return
   the results unchanged. Then, for each ticket:
   - Parent mismatch: stop, and show both routes. Agent ticket parents are not compared.
   - Fitting candidate: show it, and ask to use or update it, or create anyway. A retry that finds a
     fitting ticket it created earlier uses it without asking.
   - Non-fitting candidate: show only what differs. Never offer to reuse it.
   - Search gap: show it, and ask to search again or create anyway. Never say "no duplicate".
   - Parent gap: stop and report it. Label gap: create without labels and show the gap. Never guess
     a route, parent, or label.

4. Write the title and body.
   - Title: an imperative in sentence case, about 70 characters at most, no prefix. A bug title
     starts with `Fix <symptom>`. Fill the template, drop an empty section, keep `## Acceptance`.
   - Labels: use only fitting step 3 label IDs. Never create labels. Containers and slices get none.
   - For a bug or human ticket, call `ticket` `prepare` with the lower-case identifier when it
     exists, else a title slug. Save `title.md` and `ticket.md` in the returned `directory`; never
     write `draft.json`. Keep the type, route, parent, and labels in the preview.
   - Before review, call `ticket` `read` with `ticket` for an existing ID. Resolve `problems`.
     Review `current` and `writes` for changed fields and dropped Linear edits. Repeat on changes.

5. Approval rule for each draft, in this order.
   1. Before the question, call `draft_review` `open`, title before body. On `opened`, tell the user
      to submit comments and save edits before answering; `collect` loses unsubmitted text. On
      `manual`, give its `command` and tell the user to quit tuicr before answering.
   2. Ask with the skill's own options and no review option. After any answer, including a closed
      dialog, call `draft_review` with action `collect` and the `directory` that `open` returned.
   3. Accept with no comments, or with only `applied` edits. Merge a `conflict` edit by hand, then
      `open` and ask again. Any comment: revise, `open`, and ask again.
   4. Request changes: act on the comments, edits, and typed answer. With none, ask what to change,
      then revise, `open`, and ask again.
   5. Closed dialog: write nothing. Report each comment and edit with its status, and stop.
   - Stop: before a new ticket or a title or body edit, except on an agent ticket, ask with
     `ask_user_question`: Write as drafted (Accept), or Request changes. Comments, relations, and
     status changes get no stop. An approval preview, or a calling skill's own dialog, uses the same
     rule, with its approve options as Accept. A review is never approval.
   - Preview: for approval-needing writes under [Hard rules](#hard-rules), unless the calling skill
     shows them. Show each ticket's type, title, team, project, labels, and parent, and each
     relation or status change.

6. Write in the previewed order. Stop on a partial failure and report what was written.
   - Containers and slices: use the [slice skill](../slice/SKILL.md), which uses the `slice` tool.
   - Bug or human ticket: `read` again, then `apply` with its `stateToken` and the same arguments.
     Pass `ticket` to both for an existing ticket; `parent` and label IDs only for a create. Report
     `declined` without retry. If a create save fails, report its ID; never recreate it.
   - Comments: `ticket` `comment` with the ticket, a heading, and a body file that starts with it.
     Report the ID and URL, or `declined`, and the edits `previousBody` shows it replaced.
   - Other relations: add with `linear issue relation add <ticket> blocked-by <other>`, remove with
     `linear issue relation delete <ticket> blocked-by <other> --yes`.
   - In Progress: the [start-slice skill](../start-slice/SKILL.md) uses `start_slice` `apply` to
     move the slice. It skips `In Progress`; every other state, `In Review` included, moves. Stop
     and ask if the team lacks that state.
   - Cancel: call `ticket` `cancel`. Its confirm supplies approval. Report the returned status.

7. Link the ticket from the PR. Write `Fixes <id>` only for the ticket the PR completes, such as the
   slice, and `Related to <id>` for the rest. Never list an agent ticket or a container as fixed.

8. Report each ticket with its identifier and URL, and each relation and status change made.
