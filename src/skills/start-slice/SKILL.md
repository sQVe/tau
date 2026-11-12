---
name: start-slice
description:
  Start one slice of a planned design. Creates its branch and its agent tickets in Linear, then
  delegates the work. Picks the next slice from order, dependencies, and merge state, and reports
  the branch, base, and agent tickets it created. Use it for "start the next slice", "start
  ENG-123", or "begin this ticket as a slice". It does not split a design into slices.
metadata:
  required-for: starting a slice or creating agent tickets for a slice in Linear
---

# Start slice

## When to use

Use this after `/slice` planned the design, or for a human ticket to run as a slice. One manager
terminal runs it in one worktree, with `linear` authenticated and `gh`. To split a design, use the
[slice skill](../slice/SKILL.md).

## Hard rules

- Before step 9, write only the draft in `$slicedir`. `git fetch` is allowed. Create or switch no
  branch, and write nothing to Linear.
- Route and write tickets with the [tracker skill](../tracker/SKILL.md). Only `start_slice` writes
  agent tickets, in step 9, under the tracker's [approval rule](../tracker/SKILL.md#hard-rules). The
  only status change is the slice to In Progress.
- Before the draft, check the prompt names the repository route and agent team, as the tracker skill
  describes. If not, stop with its setup message.
- Never change a merged slice.
- On a partial failure, stop and report what completed. Read the draft and children before a retry.
- Call the `slice` tool's `prepare` action with the lower-case identifier, such as `me-537`, before
  the first file. Save files only in the returned `$slicedir`, never in `/tmp` or a shared path.
- You may add an agent ticket inside the slice's outcome: write its body file and `start.json`
  entry, judge it as step 7 says, create it as step 9 says, and report its identifier, URL, and
  reason.
- Work beyond the outcome is a new slice. Re-plan it with the [slice skill](../slice/SKILL.md).

## Procedure

1. Pick the ticket the user names, or else the one the conversation names. Ask with
   `ask_user_question` when none or several fit. Call `start_slice` `read` with that identifier as
   `pick` and the prompt's agent team as `agentTeam`. Use its `pick` result for steps 2 and 4. Name
   `chosen` in step 10 and say its `reason` in one line.
2. Check readiness from the result before any write, even for a named slice.
   - Ask the user when the named slice has status `completedWithoutMergedPr`, or a container child
     before `chosen` has that status. When no slice is chosen, check all children for that status.
   - When the user approves such a slice, it is the slice. Stop if a blocker's state is `other`.
     Take the PR URLs of its `open` blockers as `openBlockerPullRequests`. With none, the base is
     `origin/<defaultBranch>`.
   - Otherwise, if `chosen` is null, stop and report the slice statuses and blockers.
   - No `openBlockerPullRequests` means unstacked. Otherwise call the `stack` tool's `chain` with
     those URLs as `pullRequests`, and a URL from `chosen.pullRequests` as `slicePullRequest` when
     it has one. On `stop`, stop and report `reason`. Otherwise the returned `parent` is the step 4
     parent.
   - When `branchAbove` is true, ask with `ask_user_question`: wait until the parent merges
     (recommended), or stack on `topBranch`, which adds dependencies above the parent. Waiting makes
     the slice not ready. Stacking makes `topBranch` the parent.
   - When another worktree has the parent branch checked out, stop and offer the
     [handover skill](../handover/SKILL.md).
3. Read the slice with `linear issue view <slice> --json --no-pager`: its `branchName`, team, and
   `## Acceptance`. If `$slicedir/start.json` exists, read it and its body files. Read the children:
   `linear api 'query($id: String!) { issue(id: $id) { children { nodes { identifier title description team { key } project { name } } } } }' --variable id=<slice>`.
   - When a ticket with a recorded identifier lacks its body file, save its description as one.
   - When a body file differs from the description, either may be newer. Show the difference and ask
     with `ask_user_question` which to keep. A kept body goes to Linear in step 9. Keeping Linear's
     text means saving the description as the body file.
4. Choose the base from the `start_slice` `read` result, which fetched every branch of origin and
   returned `defaultBranch`. Without a parent, use `origin/<defaultBranch>`. With a parent, use
   `origin/<parent>` as the base and the `trunk` from `chain`.
5. Read the tree the workers use: the branch when
   `git rev-parse --verify --quiet refs/heads/<branchName>` finds it, else the base. Use
   `git ls-tree -r --name-only <tree>` and `git show <tree>:<path>` without switching. Follow the
   [decision evidence planning guidance](../shared/decision-evidence.md#plan-the-change), reading
   the repository instructions and decision records from this tree. Answer the
   [structure criteria](../code-quality/structure-criteria.md) plan questions for the slice's files:
   where each change goes, which helper it reuses, and which files would pass 500 lines. Without
   structure rules, also answer the module questions: which module owns the concept, what deletes
   branches or layers, and what gets more tangled.
6. Write the draft in `$slicedir`: `agent-<n>.md` per agent ticket in work order, from the
   [tracker skill](../tracker/SKILL.md) template, one worker task each, with the step 5 answers in
   `## Files`. Give each ticket the record links and rules it needs in `## Constraints`. Write
   `start.json` as the `start_slice` tool describes, with the tickets in work order. Take label IDs
   from the agent team's label list, as the tracker skill says, or use `[]`. Keep existing
   identifiers; new ones stay `null`. The tickets together cover every acceptance criterion. Give
   each journey item to one agent ticket that writes the journey file, the test, and the QA guide's
   index row together. An item marked "by hand" needs no test file. The journey file and test hold
   only built steps, following the
   [QA-guide template](../../extensions/subagents/templates/qa-guide.md#rules).

7. Map each slice criterion, record update, and mechanical-check change to its tickets. Check that
   each journey item maps to one ticket with its journey file, test or "by hand", and index row.
   Change the draft until none is uncovered. Each `## Acceptance` item must name a test, a command,
   or a manual observation, with its expected result. Rewrite an item when the slice or step 5 says
   what to check. Before step 9, list each item with no check and its body file, and tell the user
   the worker gets a vague task. Say nothing when all pass; the list never stops a launch.
8. For each new ticket (`identifier` is `null`), launch one fresh default-model `scout` in one turn.
   Brief it with the body file path, the step 5 tree, and the plan questions. It reads the body file
   with `read` and the named files with `git show <tree>:<path>`. It searches with
   `git grep <pattern> <tree>` and `git ls-tree -r --name-only <tree>` for unnamed helpers. It lists
   its questions and plan answers, or says none.
   - Revise the body file to answer each question, or proceed when the ticket or code answers it. A
     scout never blocks the start.
   - Revise `## Files` for each plan answer that changes structure.
   - After any revision, check the draft again as step 7 says.
   - A ticket with no questions and no plan answer to record goes to step 9 unchanged. A scout that
     fails to launch or stops without a report does not stop the start; step 10 names it.
9. Start in this order.
   - `git status --porcelain` must print nothing, and no worker may run. Check workers with the
     `hc ls --json` check from the [stack skill](../stack/SKILL.md). Stop and report either failure.
   - Stacked: create the branch on the parent with step 2 of the stack skill, passing the step 4
     trunk. If it stops, report what it found and stop.
   - Otherwise run `git switch --no-track -c <branchName> <base>`, or `git switch <branchName>` when
     `git rev-parse --verify --quiet refs/heads/<branchName>` finds it.
   - Call `start_slice` `read` with `directory` set to `$slicedir` and `agentTeam` set to the team
     on the `Tracker agent team:` line. Non-empty `problems`: report each and stop. Otherwise call
     `apply` with `stateToken` to move the slice to In Progress and write its agent tickets. On an
     error, stop and report the completed steps. On `status: declined`, stop and report that nothing
     was written and which tickets were unchanged.
10. Report in about 30 lines, with no raw commands: the slice and why; the branch, base, and whether
    it existed; for a stack, the parent slice and PR, trunk, PR target, and any added dependency;
    each agent ticket's `apply` status (`new`, `updated`, or `unchanged`), identifier, URL, title,
    and one `## Outcome` line; each scout's questions, whether you revised or proceeded, and each
    failed scout; each slice criterion with its ticket numbers.
11. Run the slice in this order.
    - Delegate each agent ticket to a worker with its body file path, such as
      `$slicedir/agent-1.md`. Copy its `## Acceptance` items word for word, in order, into
      `acceptance`. Tell each worker that the slice manager runs the mutation check.
    - Do not review a finished agent ticket. When a later ticket in the slice builds on a contract
      it changes, such as a type, tool schema, or file format, run one fast review of it before the
      dependent ticket starts.
    - After the last worker, run `mutation_check` once with `mode: "changed"` and `base` set to
      `git merge-base <base> HEAD`, where `<base>` is the step 4 base. Skip it, and say so, when the
      repository has no `mutation.argv`. Report a tool error and go on to prune-comments.
    - Survivors are advice. Send at most three survivor behaviors to one worker in one round, with
      step 5 of the tdd skill as its rule. That worker then reruns the affected tests and
      `mutation_check` once with the same `base`. List the survivors left open, with file and line,
      as reviewer notes for the PR.
    - After the mutation check and its survivor round, run the
      [prune-comments skill](../prune-comments/SKILL.md) on the branch diff from
      `git merge-base <base> HEAD`. It commits its own removals. Note a failed run for the PR and go
      on.
    - After the mutation check, decide on code-quality without asking. Measure
      `git merge-base <base> HEAD` to the working tree, counting untracked new files as added lines.
    - Skip when the diff touches only docs, config, or tests; when the source lines changed, added
      and deleted, total fewer than 100; or when the change is mechanical, such as a rename. Tell
      the user "skipped: <reason>". Run it later when the user asks.
    - Otherwise run the [code-quality skill](../code-quality/SKILL.md) on the slice branch, with the
      slice as the ticket under review. A stacked slice uses the merge-base diff. Tell the user "ran
      code-quality" before code-review starts.
    - Treat the branch as the user's own only when `code_review` `capture` returns
      `ownership.status` as `own`, following the
      [code-review ownership rule](../code-review/SKILL.md#hard-rules).
    - On the user's own branch, reused branches included, code-quality triage and the review fixes
      proceed without asking.
    - Run a full review with the [code-review skill](../code-review/SKILL.md) on the whole slice,
      not only the code-quality fixes, with the slice as the ticket under review. Run it once.
    - Send all in-scope findings to one fix round. Run at most one fix review, on the fix diff and
      its callers. Report findings that remain after the fix review to the user, and do not start
      triage-findings or another fix round for them.
    - Audit with the [finish-slice skill](../finish-slice/SKILL.md). Delegate each fix ticket it
      creates, as the first bullet says, except that its worker runs the mutation check with `base`
      set to the `git rev-parse HEAD` from before the ticket starts. Then audit once more. Items
      still unmet go to the pr skill as required actions.
    - Open the PR with the [pr skill](../pr/SKILL.md), and link the slice as the tracker skill says.
