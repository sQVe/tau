# Correct pass

Run this pass from any manager session when the status bar shows `correct due`. It reads every saved
improvement event, adds recent reverts and review comments, and turns repeated mistakes into
proposed checks.

1. Call the `improvement` tool with `action: correct` and no classes. Read:
   - `events`: every saved event from each project root.
   - `measures`: `repeatRateAfterCheck`, `medianFixRounds`, and `acceptanceRate`. Each has a `value`
     and a `coverage`.
   - `rejected`: the class IDs whose latest decision is `rejected`.
   - `coverage`, `skipped`, and `failed`: how many tasks are complete, manager only, or missing; the
     event files skipped and why; the project roots that failed. The measures cover every saved
     event. They do not include reverts or review comments, which step 2 adds.
2. Read the last 30 days of evidence outside the event log:
   - For each project root, run `git -C <root> log --since=30.days --grep=Revert --oneline`.
   - For each PR URL in the events, run `gh pr view <url> --json reviews,comments`.
   - For each of those PRs, run `gh api repos/<owner>/<name>/pulls/<number>/comments`.
   - A source with no result is a fact. A failed read is unknown, not empty.
3. Group the evidence into classes. Give each class a stable kebab-case `identity`, and reuse a
   prior class's identity for the same rule. Each class also has:
   - a `level` in fix order: `architecture`, `type`, `lint`, `test`, or `prose`;
   - a one-sentence `summary`;
   - `occurrences`: the event IDs or PR URLs where it happened;
   - `reverted`: whether a revert caused it;
   - `qaMiss`: whether a QA run missed it. A class counts at 2 different occurrences, or 1 revert or
     QA miss. The `correct` action drops a class whose ID is in `rejected`.
4. Call `improvement` with `action: correct` and `classes` set to the classes from step 3. Show only
   the classes it returns. A class it does not return is carried over or dropped; do not show it as
   a proposal.
5. Write the report:
   - a TLDR of at most 5 lines;
   - the three measures, each with its value and coverage, and the task coverage;
   - at most 5 classes. For each class, show its occurrences, its level, why a higher level does not
     work, and the past mistake its check must fail on. Do not apply [synthesis.md](synthesis.md)'s
     structural-to-Backlog rule. The check is the proposal.
6. Ask approve, reject, or redirect for each class with `ask_user_question`. Ask at most 4 classes
   per call.
7. For each answered class, call `improvement` with `action: record`, `kind: class`, and the
   `identity`, `level`, `summary`, and `occurrences` fields. Then call it with `action: record`,
   `kind: decision`, `class` set to the returned class ID, and `choice` set to `approved`,
   `rejected`, or `redirected`.
8. For each approved or redirected class, follow [SKILL.md](SKILL.md) step 10 to open a worktree tab
   and hand over the fix. The owning project is the project root with the most occurrences. Ask when
   two roots tie.
9. Call `improvement` with `action: record` and `kind: pass` after the answers are saved, so
   `correct due` clears. With no classes, record the pass at once. On cancellation, record nothing.
   A failed worktree or handover is reported and does not block the pass.
10. Summarize the tabs opened, the classes carried over, and the classes dropped.
