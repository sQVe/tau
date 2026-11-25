# Review comments

Use this when you write a GitHub review comment or review body.

- Write plain prose in short paragraphs. No bold headings, `Fix:` or `Regression test:` labels,
  severity badges, or tables.
- Open with the concrete failure and its consequence. Then give the short reproduction sentences.
- Give the evidence with backticked `:line` references, and the old commit when it matters.
- End with a suggestion phrased as a question, such as "Could we…", "Is that what we want?", or
  "Maybe rename it to…?".
- Each finding carries a mutation argument or an observed reproduction, or both. A mutation argument
  names what breaks when the guard is removed, with the mutant expression. A reply or a deliberate
  self-review note gives its reason in the same voice, with no invented failure and no forced line
  anchor.
- When the findings are inline, write a body of one or two friendly lines, such as "Looks great.
  Found three things that I think are worth addressing."
- Put a finding with no changed line to anchor to in the body as a short list item in the same
  voice.

## Inline comments

An observed reproduction:

```text
A failed save is retried even when the first insert committed, so the order is written twice. Run
the checkout test with a forced timeout on the first attempt, and the order table holds two rows for
one cart (`src/orders/save.ts:41`). Could we retry only the reads, or make the insert idempotent on
the cart ID?
```

State that goes stale after an edit:

```text
The header count is computed once at mount, so it stops matching the list after a filter change.
Open the page, filter to open items, and close one; the header still shows four
(`src/ui/Header.tsx:18`). Could we derive the count from the filtered list instead of storing it in
state?
```

A test that cannot fail, with the mutant expression:

```text
This test passes with the guard deleted. Remove `if (quantity < 0)` and it still passes, because
`addItem` clamps the value to zero before the assertion reads it (`src/cart/addItem.test.ts:22`).
Could we assert the thrown error instead, so a missing guard fails the test?
```

## Review bodies

Inline findings only:

```text
Looks great. Found three things that I think are worth addressing.
```

One line and two unanchored findings:

```text
Looks good overall. Two things I could not pin to a line:

- The migration and the model change are separate commits, so reverting the migration alone leaves
  the code writing to a dropped column (`src/orders/save.ts:58`). Revert only that commit and the
  order path fails on the next save. Is that what we want?
- The new flag is on for existing accounts, so every current account starts sending a daily digest
  (`src/digest/send.ts:24`). Open the settings of an account created before this change and the
  toggle already reads on. Maybe default it to off and let people opt in?
```
