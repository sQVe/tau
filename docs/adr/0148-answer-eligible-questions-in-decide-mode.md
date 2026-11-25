# ADR 0148: Answer eligible questions in decide mode

**Date**: 2026-11-22\
**Status**: Accepted\
**Related**: [0147 (Measure the question gate in shadow mode)](./0147-measure-the-question-gate-in-shadow-mode.md),
[0107 (Put user decisions first with stated problems and stable options)](./0107-state-the-problem-and-keep-option-order-stable-in-questions.md)

## Context

Shadow mode records how the gate would answer an eligible question, but the dialog still decides.
The shadow records can show that a frozen candidate agrees with users without letting that candidate
take the dialog away. Decide mode uses the same candidate to answer a call, so the measured behavior
and the answering behavior stay one candidate.

An answer saves a dialog, so the user cannot correct it. The gate must answer only where the frozen
sample says it may, must not stall the session, and must leave a record of what it answered.

## Decision

With `questionGate.decide` set to true, Tau answers an eligible `ask_user_question` call without
opening the dialog. Decide mode is off by default.

### Reuse the frozen shadow candidate

Decide mode reads the same `shadow` block as shadow mode: the variant, cutoff, examples, classifier,
and panel. The decision record carries the same cohort hash, so a candidate measured in shadow mode
is the candidate that answers. A changed candidate starts a new cohort and needs new shadow records
before its agreement is known.

### Bound judging to five seconds

Judging a whole call gets five seconds. A question without a verdict when the deadline passes is a
timeout, and a timeout asks. The deadline covers judging only. Reading config, Git, and writing the
record are local steps and are not timed.

### Answer one question or ask the call

A call is eligible only when it holds exactly one question, and that question is eligible under the
shadow sample. Any other call asks. The shadow sample holds single-question dialogs, so answering a
batch would answer a shape the sample never measured.

### Audit one decision in five

One would-be decision in five goes to the dialog instead. The dialog starts the normal shadow job,
which records all five variants and the asker's confidence, so the measured sample can include calls
the gate answers.

The shadow job keeps its own rules. It records at most one batch per minute, and it writes nothing
when a model it needs is not allowed, so an audited call can ask without adding a record. It also
judges the question again, and its verdict can differ from the one that decided the call. The score
counts the shadow record's verdict.

A decided call opens no dialog, so it writes no shadow record. Without the audit, every record would
come from a call the gate asked, and the sample would never cover a call the gate answered.

### Show the notice before saving, and ask on failure

Tau shows the notice before it writes the decision record. If the notice cannot be shown, Tau writes
nothing and opens the dialog. If the record cannot be saved after the notice, Tau opens the dialog
for the same question. A failed save can therefore show a notice for a question that is then asked,
and the dialog corrects it. No record exists for a call that fell back to the dialog.

### Treat the notice as the commit point

Cancellation before the notice shows nothing, asks nothing, and writes nothing. After the notice,
Tau finishes writing the record even when the call is cancelled, because the user has already seen
the answer. If the write fails, Tau asks, unless the call was cancelled: Pi drops the result of a
cancelled call, so opening a dialog for it would ask a question nobody receives.

### Mark the result as the gate's

A gate answer returns a `decided` result kind with the chosen labels and the record path. Its text
says the question gate answered, that this is not the user's answer, and that it never approves
publishing, pushing, or posting. The result is not a dialog result, so a caller can tell the two
apart. A `decided` result adds no branch fact, so it cannot hide an older typed answer.

### Take the reason from the option description

The judges return a verdict, not a rationale. The notice and record use the recommended option's
description as the reason, so the explanation is the one the model wrote for the user. The gate does
not invent a separate justification.

### Look up records by shared repository root and branch name

The record is written under the shared repository root's `.tau/questions`. A pull request finds
records by that root and the short branch name. A reused branch name can therefore list older
records, which the report shows with their time and head so a reader can tell them apart.

## Consequences

### Positive

- An eligible call costs no dialog when the frozen candidate is confident enough.
- The candidate that answered is the candidate that shadow records measured.
- A failed save or notice leaves the user with the dialog instead of a silent answer.
- A cancelled call before the notice leaves no notice, no record, and no dialog.
- The record makes each gate answer visible after the fact.
- The shadow sample can include a call the gate answered, not only calls it asked.

### Negative

- The user cannot correct an answer that the gate gave.
- A reused branch name can mix records from more than one attempt.
- A failed save after the notice shows a notice for a question that is then asked, and the dialog
  corrects it.
- Five seconds is a fixed budget; a slower judge asks even when it would eventually agree.
- The reason repeats the option description, which may be longer than a dedicated rationale.
- One decided call in five costs the dialog the gate could have saved.
- Every would-be decision costs one judge run, even when the audit sends the call to the dialog.
- A call with more than one eligible question never gets a gate answer, even when the frozen
  candidate would agree.
- An audited call adds no record when the shadow job's minute limit or a refused model blocks it.
- The shadow job judges the question again, so a record can hold a different verdict from the one
  that decided the call.

## Alternatives considered

### Decide each question in a batch on its own

Answer the eligible questions and ask the ineligible ones in the same call. Rejected because the
dialog would show only part of the call, and the record, notice, and result would no longer describe
one batch.

### Audit before judging

Sample the call before the judges run, so an audited call costs no judge call. Rejected because the
sample would also take calls the gate would have asked, which adds no coverage of gate answers, and
it would not identify which diverted calls the gate would have decided.

### Measure only the calls the gate answers

Write a shadow record from the verdicts of a decided call. Rejected because the record would then
hold no user answer, and the user's answer is the outcome the agreement score compares.

### Hide the gate answer behind the normal dialog

Let the gate answer while the user sees the usual question. Rejected because the user cannot see or
correct a decision the interface hides, and the record would no longer describe the dialog the user
faced.

### Let judging run until every judge replies

Wait for all judges regardless of time. Rejected because the user waits on a dialog that may never
open, and a stalled model would hold the session.

### Store a separate rationale from the judges

Ask a judge for a reason and save it. Rejected because the judges return a verdict only, and a
second model call would cost more and could disagree with the option text the user would see.
