# ADR 0123: Delete stopped worker records 14 days after their last write

**Date**: 2026-10-26\
**Status**: Accepted\
**Related**: [ADR 0097 (Track only the current session's workers)](./0097-track-only-the-current-sessions-workers.md),
[ADR 0045 (Keep worker records per Tau checkout and worktree files in `.tau/`)](./0045-keep-worker-records-per-checkout-and-worktree-files-in-tau.md)

## Context

Each worker leaves a task directory in its checkout's worker store. Nothing deleted these
directories, so the store grew with every launch. One store reached more than 5,000 directories and
about 2 GB, mostly saved worker conversations.

A manager reads only its own session's tasks during a session. It still lists the whole store once
when the session starts, so that scan grows with every saved directory. Most directories belong to
sessions that ended long ago. Their reports and conversations are rarely read after the work they
served has merged.

Some old directories must stay. A running worker or a stop that the parent never confirmed may still
own a pane. A follow-up records its predecessor's task ID and reuses the predecessor's conversation
file, which lives in the predecessor's directory.

## Decision

Tau deletes a stopped worker's task directory 14 days after the newest write in it. A worker counts
as stopped only when the parent's cleanup record confirms the stop. The rule keeps these directories
regardless of age:

- A worker without a confirmed stop, which covers running workers and unconfirmed cleanups.
- A task of the session that runs the deletion, so its status and follow-ups keep their records.
- The predecessor of a kept task, and the directory that holds a kept task's conversation file. Kept
  predecessors keep their own predecessors in turn.

A deletion fails closed. It reads a worker's age after all its other records, so a record written
during the scan makes the worker recent. A worker whose files change or cannot be read during the
scan is kept, with the tasks it points to. Just before it deletes a directory, the deletion reads
the directory's age again, and it ends the pass when the directory was written since the scan. It
deletes each task before the tasks it points to, so a pass that ends early keeps a newly written
task's predecessors.

A task record that was read but does not parse hides the tasks it points to. While it was written
within 14 days, the pass deletes nothing. Once it was not written for 14 days, it is deleted like a
stopped worker and blocks nothing: a follow-up it might record would be past the 13-day limit, so it
protects no source.

A task record that fails to read for another reason than being absent, such as a permission error,
may still be valid. Its worker is kept regardless of age, and the pass deletes nothing until the
record reads again.

The manager runs the deletion once after it resumes its saved workers at session start. It runs in
the background, so tool calls and the worker widget never wait for it.

### Refuse follow-ups one day before deletion

Another manager can start a follow-up of an old source while a deletion runs. Instead of
coordinating the two, Tau keeps a time margin between them. A follow-up refuses a source whose
newest write is more than 13 days old, with an error that names the limit. It checks this when it
claims the source, before it writes anything, from the same last-write fact that the deletion reads.
A deletion removes only directories more than 14 days old. A source that a follow-up accepts is
therefore at least a day away from deletion. Once the follow-up publishes its task, the deletion
keeps the source as the predecessor of a kept task, and the follow-up's writes to the shared
conversation make the source recent again.

The rule also covers task records in retired formats. ADR 0097 kept those records on disk forever.
They now expire under the same rule, because Tau cannot control them and they cost the same scan
time as current records.

Fourteen days leaves time for follow-ups after a paused session and keeps the store to recent work.

## Consequences

### Positive

- The session start scan and the disk use stay bounded by recent work.
- Old retired task records no longer stay on disk forever.

### Negative

- A report or conversation older than 14 days is gone unless someone copied it elsewhere first.
- A session resumed after 14 days loses the stopped workers that another session deleted while it
  was closed.
- A task record that does not parse stops all deletion for up to 14 days after its last write.
- A worker without a confirmed stop is deleted after 14 days when its task record does not parse.
- A task record that cannot be read stops all deletion until someone fixes its permissions or
  removes it.
- A manager cannot follow up a worker whose task was last written more than 13 days ago.
- A follow-up that stalls more than a day between its age check and the publication of its task can
  lose its source to a deletion.
- A clock that moves forward by a day or more, or file times set from another clock, can make a
  deletion remove a source that a follow-up just accepted.
- A Tau process of the same checkout that started before this rule does not check the 13-day limit.
  A follow-up it starts on a source near 14 days old can lose its source to a deletion.

## Alternatives considered

### Keep every record and only avoid scanning it

Keep all directories and rely on the in-memory list of the session's own tasks. Rejected because the
start scan and the disk use still grow without limit.

### Move old records to an archive directory

Move expired directories out of the store instead of deleting them. Rejected because saved tasks
hold absolute paths to their conversation files, and a move breaks follow-ups and older Tau versions
that read them.

### Move expired directories aside and check again

Rename expired directories out of the store, list the store again, and move back each directory a
new follow-up needs. Rejected because a follow-up that publishes into a directory the deletion
already read can pass its source check before the source moves, and an interrupted pass needs a
restore step that can race with the session's own tasks.

### Keep records for 30 days

Use a longer limit to keep more old reports. Rejected because worker conversations make up most of
the store, and 30 days roughly doubles that disk use for reports that are rarely read.

### Keep records for 7 days, like test run diagnostics

Use the limit of Tau's test run diagnostics. Rejected because another session's deletion would
remove the stopped workers of a session paused for just over a week, before it can follow them up.
