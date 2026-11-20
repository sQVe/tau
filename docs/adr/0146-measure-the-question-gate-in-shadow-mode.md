# ADR 0146: Measure the question gate in shadow mode

**Date**: 2026-11-20\
**Status**: Accepted

## Context

Tau can sample a question and judge it while the dialog still decides the answer. Scoring each
question as an independent observation overstates confidence when one session answers many
questions. The historical scorer also chooses a cutoff from the same logs it scores, so it cannot
show that a frozen candidate works on fresh dialogs.

## Decision

The dialog stays authoritative in shadow mode. Tau records the judges' verdicts and the user's real
answer, and it never takes the dialog away from the user. The report scores the frozen candidate
that produced the records. It makes no model calls and takes no launch decision.

### Freeze the candidate before observation

A cohort identifier hashes the classifier, panel, variant, cutoff, and example inputs. Each shadow
record carries the cohort, and the report keeps only records with the current cohort. Changing any
frozen input starts a new cohort, so old records cannot flatter a new candidate.

### Score sessions, not questions

Only predicted decisions enter the agreement score. A session contributes one mean over its
predictions, weighted by its share of the predictions. The one-sided 95% lower bound is

```text
max(0, agreement - sqrt(log(20) * sum(w_s^2) / 2))
```

where `w_s` is session `s`'s share of predictions. This is a weighted Hoeffding bound over bounded
session means. It assumes independence between sessions given their sampled decision counts.
Questions in one session can share a user, a project, and a moment, so they are not independent
observations.

The sample is the dialogs the gate could replace: one explicit choice question with exactly one
recommendation, no preview, and no multi-select. It is not a representative sample of all dialogs. A
decide verdict is a potential saved dialog, not a saved dialog. Actual saves stay zero while the
dialog remains authoritative.

The historical scorer for ME-1678 keeps its own path. It compares judge variants on old logs and
chooses a cutoff there. This report reads only new shadow records, reports the frozen candidate, and
does not tune its cutoff.

## Consequences

### Positive

- A session with many questions cannot raise confidence as if each question were independent.
- A frozen cohort separates the records that score a candidate from the records that helped choose
  it.
- The report needs no model calls, so a replay costs no tokens and changes no files.

### Negative

- The bound is conservative, because it assumes independence only between sessions and treats each
  session mean as bounded.
- A changed candidate needs new records before its cohort can report.
- The sample covers only eligible single-choice dialogs, so the report says nothing about other
  dialog kinds.

## Alternatives considered

### Hidden automatic decisions

Let the gate answer the dialog while the user sees the usual question. Rejected because the user
cannot see or correct a decision that the interface hides, and the record would no longer measure
the dialog the user actually faced.

### Tune the cutoff on the shadow records

Choose the best cutoff from the same records that report agreement. Rejected because the reported
bound would describe a cutoff selected after seeing the outcomes, which overstates its performance
on fresh dialogs.

### Treat questions as independent observations

Use the question count in place of the session count. Rejected because questions from one session
share context, so the independence assumption fails and the bound becomes too narrow.
