# ADR 0112: Review collaborative drafts as files in tuicr

**Date**: 2026-10-15\
**Status**: Accepted\
**Related**: [ADR 0053 (Version each saved record format)](./0053-version-each-saved-record-format.md),
[ADR 0107 (State the problem and keep option order stable in questions)](./0107-state-the-problem-and-keep-option-order-stable-in-questions.md)

## Context

Skills show the user drafts to approve: ticket bodies, slice plans, designs, PR text, and ADRs. The
user could read them only in the chat or in an `ask_user_question` preview. Neither lets the user
comment on one line or fix a word in place, so feedback came back as prose that the agent had to map
to the text.

tuicr already gives the user line comments with vim keys and stores them where a command can read
them back. It keeps one file session per repository, so drafts in one repository share their
comments. It opens one file inside a Git worktree, but not a directory of ignored files such as
`.tau/`.

## Decision

Every draft the user and Tau work on together is a Markdown file under `.tau/`, and skills show it
to the user with the `draft_review` tool, which opens it in tuicr.

### The review

- The tool copies the drafts to a staging directory outside Git and opens tuicr on it. In herdr it
  opens a right split beside the agent when the agent pane is wide enough for two usable panes, and
  a new focused tab in the agent's workspace when it is narrow or zoomed. It then waits. Outside
  herdr it returns the command, and a second call collects the review after the user says done.
- tuicr exiting, or its pane closing, ends the review. Only cancelling the tool call cancels it.
- The tool returns the user's comments on the reviewed drafts and a diff of each draft the user
  edited. It deletes only the comments it returned, because other drafts share the session.
- It writes the user's edits back only when the real file still matches the copy it staged. Any
  other case is a conflict, which the agent resolves. An agent edit is never overwritten.
- It saves the collected result before it deletes or writes anything, so a retry after a failure
  loses no comment.

### Approval

- Approval dialogs keep their preview and offer "Review in tuicr" as the recommended option.
- A review never counts as approval. After a review, the skill revises the draft and asks again.

## Consequences

### Positive

- The user comments on exact lines and fixes wording directly, and the agent gets both back as data.
- One tool owns staging, waiting, filtering, and write-back, so skills add a review with one call.
- Approval rules do not change.

### Negative

- The review needs tuicr installed. Outside herdr it also needs a manual command and a second call.
- A review adds a round to each approval it is used in.
- The tool depends on tuicr's session list and comment JSON, which a tuicr release can change.
- Edits the user makes outside the staged copies, such as in the real `.tau` file, are not seen.

## Alternatives considered

### Skill text only

Each skill tells the agent to run herdr, tuicr, and a diff by bash. Rejected because every agent
would repeat the wait, the per-file comment filter, and the snapshot by hand, and the probes showed
data loss in exactly those steps.

### A review option inside `ask_user_question`

An approval option carries a draft path, and the dialog runs the review. Rejected because it ties
the generic dialog to tuicr and herdr, and drafts with no dialog, such as a design between rounds,
could not be reviewed.

### `leaf` as the viewer

`leaf` renders Markdown in the terminal. Rejected because it has no comment store, so the agent
could read back only file edits.

### Comments only

The tool returns tuicr comments and ignores file edits. Rejected because the user wants to fix
wording directly instead of describing each change in a comment.
