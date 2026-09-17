---
'tau': minor
---

Let active Pi workers ask their parent for clarification without exiting. Save validated questions,
replies, and worker acknowledgements separately. Deliver replies once through herdr after checking
the original worker identity. Preserve the assigned scope, saved settings, and original parent-owned
deadline while waiting.

Recover pending questions and reply receipts with `subagent_status`. Repeated recovery preserves
accepted content and does not resend uncertain deliveries. Acknowledgement records worker receipt,
not successful side effects. Saved evidence after parent exit does not imply continuing enforcement.

Use versioned provider fingerprints for new workers so resolved API-key rotation can preserve saved
settings. Keep legacy hashes strict and refuse changed headers or configuration. New fingerprints
also bind the complete `models.json` file, so unrelated edits to that file require a fresh task.
Compare live provider settings, including resolved keys, with a fresh reconstruction at launch,
saved-loadout validation, and worker startup. Refuse differing current keys, including rotation
during validation, because they cannot be distinguished from stale literal configuration. Rotation
between resolution and startup remains supported when current settings agree. Validate saved
loadouts without rediscovering profiles.

Persist role-prefixed, two-character Nano ID worker names alongside full task IDs. Check retained
parent-session names and all live herdr names before publication, with bounded collision attempts.
Failed live listing and uncertain startup never trigger a launch retry.

Add read-only `subagent_history` for the current root session and its validated descendants. Return
clarification candidates for ambiguous names, IDs, or descriptions. Retain reports and native
references after pane cleanup or missing transcripts. History does not grant reply/cancel ownership,
resume work, or copy transcripts. Older records remain unnamed.

Page bounded history previews without changing full-match ambiguity. Keep source-file references for
complete records. Include explicit current and ancestor session files regardless of filename
extension, and merge discovered metadata without duplicate candidates.

Add explicit `subagent_follow_up` for an exact saved task in the authorized root-session tree.
Require a valid final handover and confirmed parent cleanup. Start a new task ID, friendly name, and
bounded deadline on the same native session, with unchanged saved settings and original native
lineage. Preserve earlier task/report records and keep same-task restart refused.

Claim one successor per predecessor before native opening. Recheck the existing regular native file
and refuse known live writers. Preserve uncertain claims and preparation evidence; never retry or
reclaim by age. Claims coordinate Tau launchers, not arbitrary manual Pi writers. History shows
validated continuation chains without choosing their newest task automatically.
