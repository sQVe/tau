# ADR 0153: Refuse a qa success report without a page inventory

**Date**: 2026-11-25\
**Status**: Accepted

## Context

A `qa` worker can report success after checking only the slice's target. Two saved corrections show
the result: a leftover "Your inbox" card stayed on a team overview through many slices, and a page
titled "Account settings" shipped under a menu link named "Notification settings". In both cases the
browser pass saw the target, found it right, and said nothing about the rest of the page. Nothing in
Tau checked what the pass looked at, so the unseen parts passed with it.

The smallest defense is a report gate that asks for a list of what the pass saw. Comparing that list
with browser snapshots would catch more, but it couples the report to snapshot tooling and needs a
completeness rule the snapshots cannot settle.

## Decision

A `qa` success report on a task with an `App URL:` line must carry a page inventory. The worker
writes `page-inventory.md` in its assignment directory and cites the path. In evidence the item is
the path alone. In the summary the path is a whole reference followed by a space, the end of the
line, or a sentence period. Each page starts with its http or https URL on its own line, followed by
one `- <element>: <expected state>: <verdict>` item per visible element. The element is the text
before the first `: `, so the expected state may contain colons. A verdict is `matches`,
`contradicts`, or `unsure`.

The report is refused, each reason with its own message, when the file is missing, uncited, has no
page, has a page with no element, has a line that is not a page URL, has a malformed element line,
has an unknown verdict, or leaves a `contradicts` or `unsure` element out of the summary's Decisions
section, in any heading shape the report section check accepts. A Decisions finding names the
element at the start of its own line as `- <element>: <finding>`. A refusal saves no report and sets
no report label, like the full check refusals.

The trigger is the `qa` profile and the `App URL:` line that the launch adds when the lead passes
`url`. Other profiles, a task without that line, and `incomplete` or `failure` outcomes keep their
old behavior. The browser profile and its instructions do not change, because it is not the profile
that judges whether a page matches its expected state.

Tau parses the inventory once at the boundary into a typed value and passes it to a pure decision.
The `qa` profile also tells the worker to list every element on each page, not only the target, and
to name each `contradicts` or `unsure` element in `## Decisions`.

## Consequences

### Positive

- A `qa` success report now shows which pages and elements the pass saw.
- A contradiction the worker noticed cannot stay out of the report's decisions.
- Each refusal says what is missing and what to do next.

### Negative

- The gate proves the inventory exists and is well formed, not that it is complete. A worker that
  lists only the target element still passes, so completeness stays a prose rule in the `qa`
  profile.
- The gate reads the summary's text, so an unusual Markdown shape can still pass or be refused. A
  path split across bullets, or a suffix of a longer formatted path, can satisfy a citation. A
  quoted example can count as the missing Decisions finding. A heading that continues after a colon
  or a parenthesis, such as `## Decisions (example)`, counts as the Decisions section, so only a
  fenced example stays excluded. The inventory file itself is the authoritative record.
- A `qa` follow-up task replaces the brief, so it carries no `App URL:` line and the gate does not
  apply. ME-1968 tracks this gap.
- A worker that saw a page must spend report space on it.
- The inventory format needs a parser that can refuse a line the worker wrote in a different shape.

## Alternatives considered

### Compare the inventory with browser snapshots

Read the browser snapshots of each visited page and refuse when an element is absent from the
inventory. Rejected because it couples the report gate to one browser tool, adds a completeness rule
that the snapshots cannot settle, and makes every snapshot format change a report failure.

### Gate every profile that can open a browser

Apply the inventory rule to `browser` and `qa` alike. Rejected because the two past mistakes came
from page judgments, which are `qa` work. The browser profile has other jobs, and its instructions
stay as they are.

### Keep only the prose rule in the qa profile

Tell the worker to list every element and trust it. Rejected because both past mistakes happened
with no list at all, and a report that names only its target leaves no trace of the rest of the
page.
