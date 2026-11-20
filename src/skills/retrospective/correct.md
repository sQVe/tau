# Correct pass

Run this pass from any manager session when the status bar shows `correct due`. It reads every saved
improvement event, adds recent reverts and review comments, and turns repeated mistakes into
proposed checks.

1. Call the `improvement` tool with `action: correct` and no classes. Read:
   - `events`: every saved event from each project root.
   - `projectRoots`: the project roots whose events were read.
   - `eventOwners`: the project root each event came from, with its event ID.
   - `measures`: `repeatRateAfterCheck`, `medianFixRounds`, and `acceptanceRate`. Each has a `value`
     and a `coverage`.
   - `rejected`: the class IDs whose latest decision is `rejected`.
   - `coverage`, `gaps`, and `failed`: how many tasks are complete, manager only, or missing; the
     event files skipped and why; the project roots that failed. The measures cover every saved
     event. They do not include reverts or review comments, which step 3 adds.
   - `indexProblem`: why the sweep index could not be read, or `null`. When it is set, the pass read
     only the roots it could find. Report it in the TLDR.
2. Group the evidence into classes. Give each class a stable kebab-case `identity`, and reuse a
   prior class's identity for the same rule. Each class also has:
   - a `level` in fix order: `architecture`, `type`, `lint`, `test`, or `prose`;
   - a one-sentence `summary`;
   - `occurrences`: the event IDs or PR URLs where it happened. A class counts at 2 different
     occurrences, or 1 revert or QA miss. The `correct` action drops a class whose identity matches
     a rejected class and whose occurrences are all in that rejected class's occurrences. A new
     occurrence makes it a new class.
3. Call `improvement` with `action: history`, `projectRoots` set to the deduplicated roots of the
   classes' occurrences taken from `eventOwners`, and `pullRequests` set to the deduplicated PR URLs
   among those occurrences. Use its result to set each class's `reverted` and `qaMiss`:
   - `reverted`: whether a revert caused it;
   - `qaMiss`: whether a QA run missed it. When `coverage` is `partial` or `unknown`, say so in the
     TLDR and do not claim a class was not reverted. Do not run `git` or `gh` by hand.
4. Call `improvement` with `action: correct` and `classes` set to the classes from step 2. Show only
   the classes it returns. A class it does not return is carried over or dropped; do not show it as
   a proposal.
5. Write the report:
   - a TLDR of at most 5 lines;
   - the three measures, each with its value and coverage, and the task coverage;
   - at most 5 classes. For each class, show its occurrences, its level, why a higher level does not
     work, and the past mistake its check must fail on. Do not apply [synthesis.md](synthesis.md)'s
     structural-to-Backlog rule. The check is the proposal.
6. Ask approve, reject, or redirect for each class with `ask_user_question`. Ask at most 4 classes
   per call. A redirect approves nothing: rewrite the class, show it again, and ask again before
   step 8.
7. For each class, find its owning project: the project root with the most occurrences in
   `eventOwners`. Ask when two roots tie or an occurrence has no owner. Then call `improvement` with
   `action: record`, `kind: class`, `projectRoot` set to that root, and the `identity`, `level`,
   `summary`, and `occurrences` fields. Then call it with `action: record`, `kind: decision`,
   `projectRoot` set to the same root, `class` set to the returned class ID, and `choice` set to the
   answer the user ended with. A redirect is not a terminal answer.
8. For each approved class, follow [SKILL.md](SKILL.md) step 10 to open a worktree tab in its owning
   project and hand over the fix.
9. Call `improvement` with `action: record` and `kind: pass` after the answers are saved, so
   `correct due` clears. With no classes, record the pass at once. On cancellation, record nothing.
   A failed worktree or handover is reported and does not block the pass.
10. Summarize the tabs opened, the classes carried over, and the classes dropped.
