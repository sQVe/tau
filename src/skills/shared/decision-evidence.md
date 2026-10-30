# Decision evidence

Use this guidance for the change under review or publication, with or without a ticket. Keep the
evidence in the existing review report and PR artifacts. Do not create a document just to prove that
this check happened.

## Assess the change

1. Read the applicable repository instructions, decision-recording policy, and relevant design
   records. Name the sources and the changed behavior they govern. If no policy or relevant record
   exists, name where you looked and why none applies; absence is not a compliance claim.
2. Identify lasting choices introduced or changed by this diff. For each, state the choice, its
   lasting reason, and a credible rejected alternative. Follow the repository's policy to decide
   whether to add, update, replace, or omit a record. For a lasting choice without a recording
   policy, ask the user to resolve its recording destination before calling it complete. Do the same
   when policy requires a record but leaves its destination unclear.
3. Check implementation and affected callers against those decisions. Cite changed paths and
   decisive source, test, or walkthrough evidence. A record's existence alone does not show
   compliance. A known contradiction needs a correction to the implementation or an approved
   decision change recorded under the repository's policy; it is not missing evidence.
4. Record a change-specific conclusion. For unchanged relevant decisions, explain how this change
   still follows them and why no record edit is needed. With no relevant decisions or lasting new
   choice, explain that conclusion from the scope and sources inspected. Neither conclusion needs a
   new document. List unread sources, unresolved destinations, and unsupported claims as gaps, with
   what would resolve each. Report contradictions separately.

## Reuse and recheck

- Identify the reviewed scope, supporting sources, and their checked content in the report, using
  existing capture identities, pinned revisions, or saved evidence references. Include relevant
  policy and callers outside the capture. If their checked content cannot be established, report a
  gap rather than assume it is unchanged.
- Reuse a conclusion only when the change and its supporting evidence still support it. Recheck
  after relevant implementation, caller, policy, decision-record, or publication-claim changes.
  Capture freshness cannot establish that outside sources stayed unchanged.
- Reassess affected conclusions and gaps after relevant changes, including user edits in a preview.
  An exception applies only to the change and gap the user approved. Invalidate it when that scope,
  gap, or supporting evidence changes, and obtain new approval if the gap remains.
- Keep content coverage, capture freshness, review verdicts, and decision evidence separate. A HEAD
  move with unchanged reviewed content does not by itself require another review or invalidate
  decision evidence. Use the existing review-chain rules; do not rewrite capture artifacts.

## Publication gate

- Before publishing a draft or ready PR, updating one, or marking one ready, require current
  change-specific decision evidence. Apply this gate on retries and continue paths too. It is
  independent of ticket audits and readiness suggestions; choosing draft does not bypass it.
- Stop for missing or stale evidence. Resolve it, or ask for explicit approval of a named
  change-specific gap. State what is missing, the affected choice or compliance claim, the risk, and
  what would resolve it. Ordinary publish approval or approval to leave readiness actions open is
  not a gap exception.
- Record an approved exception and its exact gap in both the publication preview and PR body. Never
  describe an exception as compliance. Keep the preview and body consistent after edits.
- Stop for a known contradiction. A gap exception cannot authorize it. Resolve the contradiction
  before publication, even when the user chooses ready despite other open actions.
