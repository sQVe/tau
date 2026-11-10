# Review report

Use this shape for the files in `$dir` and for the reply.

## Saved files

- Each worker report: `reviewer.md`, or `finder.md` and `checker.md`.
- `report.md`, the comment body. With a ticket, start it with `# Code review: <ticket>` and keep a
  `Comment ID:` line once the comment exists. Include the target kind, the base and HEAD SHAs, the
  capture `hash`, the capture `identity`, the source of any check result, every finding in full, and
  refuted candidates with the checker's reason.
- For a fast review, also include an `Unread files` section copied from the reviewer report, which
  lists the captured files it did not read or says "None". When the report lacks it, write
  `unavailable` and list it as a gap.
- For a fix review, also include the predecessor review directory (`target.review` in
  `capture.json`) and its identity (`target.predecessor.identity`). When `capture.json` has no
  `target.predecessor`, as for a fix on a legacy review, write the identity as `unavailable`. Never
  guess it.

## Decision evidence

Include a Decision evidence section in each worker report and `report.md`, and summarize it in the
reply. Follow [decision evidence](../shared/decision-evidence.md): name the applicable policy and
decisions, lasting choices and required record changes, compliance evidence, and the change-specific
reason for any no-change conclusion. Identify the checked scope and supporting content, including
sources outside the capture. List gaps and contradictions separately; a clean findings table does
not replace this assessment.

## Reply

- Header: the target, mode, elapsed time when you observed it, freshness (fresh, stale, or unknown),
  and a link to `report.md`. For a fast review, add the unread files, or "None". Say once how
  findings were checked: fast has one self-checking reviewer; deep adds a fresh checker.
- Findings: one table, most severe first, with the columns `#`, `Problem and impact`, `Evidence`,
  and `Recommendation`. Put long evidence and fix directions in numbered notes after it.
  - Evidence: the `file:line` and the decisive fact, such as a caller, guard, test, or reproduction.
    In deep mode, add the status: supported, disputed (refuted but still plausible), uncertain, or
    checker-new.
  - Recommendation: fix, investigate, or defer, with a reason from the evidence and the cost of
    acting, plus a bounded fix direction or the question to investigate.
- Status says how a finding was checked, not how strong it is. Decisive evidence can justify fixing
  a checker-new finding. Do not rank confidence or give scores. Your agreement does not change a
  status. Say what source you read to reach a recommendation.
- Do not redo the review. Keep every material plausible or disputed finding. Remove only exact
  duplicates and style points no rule supports, and name each in one line. Show refuted candidates
  only when one affects a decision.
- Gaps: list every gap from the capture and the evidence, areas workers left unread, worker
  failures, stale or unknown freshness, and a check result that may not match the capture. Do not
  infer read coverage from citations.
- Notes: areas workers read only shallowly. They are not gaps.
- With no findings from a complete, fresh run, show no table. Say the workers found no material
  issues in the scope they read. That does not prove the change correct.

## Known reviews

The manager keeps this register before it claims that review is complete overall, or that a change
is ready to publish, when more than one independent review of the change is known. A review is known
when this session produced or read it, or when the user or a handover supplies its path or URL. Do
not search history for others. With one review chain and no other known review, skip the register.

Write one entry per known report. Keep each finding in its original report:

```markdown
- <path or URL>: <scope>; identity <identity or "unavailable">.
  - <finding reference>: <disposition>. <evidence>.
```

- Scope: the target kind and the range or paths the report covered. Identity: the capture
  `identity`, the GitHub review ID, or the reviewed commit, whichever exists.
- Finding reference: the report's number or a short title, never a copy of the finding.
- Disposition: a [triage-findings](../triage-findings/SKILL.md) outcome, Open when nobody verified
  it, or Superseded. Give the commit, test, or `file:line` that supports it.
- Settle each finding on its own against the current code. A stale report or a moved head settles
  none of its findings.
- Superseded names the later assessment and the exact scope it covered again. Findings outside that
  scope keep their own disposition.
- An irrelevant report gets its entry with the reason its scope misses this change, and no findings.
- An unreadable relevant report gets its entry marked unreadable and stays a gap.

Claim that all known reviews passed only when every relevant report was read and every finding is
Fixed, Not worth changing, Incorrect, or Superseded. Otherwise name the open findings and gaps, and
claim only what holds, such as "the selected threads are resolved". Open findings limit the claim.
They add no publication gate and do not start more review or fixes. The register does not replace
capture freshness, coverage, verdicts, acceptance, branch checks, CI, deployment, or publication
approval.
