---
name: start-slice
description:
  Start one slice of a planned design. Creates its branch and its agent tickets in Linear, then
  delegates the work. Picks the next slice from order, dependencies, and merge state, and reports
  the branch, base, and agent tickets it created. Use it for "start the next slice", "start
  ENG-123", or "begin this ticket as a slice". It does not split a design into slices.
metadata:
  required-for:
    starting a slice or creating agent tickets for a slice in Linear, including as a step in a
    larger task
---

# Start slice

## When to use

Use this skill to start work on one slice, after `/slice` planned the design or for any human ticket
the user wants to run as a slice. One manager pane inside herdr runs the whole flow in one worktree.
It needs the `linear` CLI authenticated for the workspace, and `gh` for merge state.

Do not use it to split or re-plan a design. Use the [slice skill](../slice/SKILL.md) for that.

## Goal

The slice has a branch named after it, checked out in this worktree, and agent tickets under it in
the agent team. The draft covered every acceptance criterion before anything was written to Linear
or Git. Workers then carry out the agent tickets.

## Hard rules

- Before step 9, write only the draft in `$slicedir`. You may run `git fetch`, but create or switch
  no branch and write nothing to Linear.
- Route and write tickets with the [tracker skill](../tracker/SKILL.md), except that the
  `start_slice` tool creates and updates the agent tickets in step 9. Follow its
  [rule on which writes need approval](../tracker/SKILL.md#hard-rules) and its hard rules on
  questions and status. This skill's only status change is moving the slice to In Progress in
  step 9.
- Before you write the draft, check that the prompt names both the repository route and the agent
  team as the tracker skill describes. If either is missing, stop with the tracker skill's setup
  message.
- Never change a merged slice.
- If a step fails partway, stop and report what completed. Read the draft and the slice's children
  before you retry anything.
- Before you save the first file, call the `slice` tool's `prepare` action with the slice's
  identifier in lower case, such as `me-537`. Use the returned `directory` as `$slicedir` for every
  file you save. Save no file until the tool has prepared the directory. Never write scratch files
  to `/tmp` or another shared path.

## Procedure

1. Pick the slice. If the user names no ticket, use the one ticket the conversation already names as
   the slice or container, and name it in the step 10 report. Ask when none or several fit.
   - A container is a ticket with children in its own team. Those children are its slices.
   - Any other ticket the user names is the slice itself, including a one-slice design with no
     container.

   For a container, read its slices:

   ```sh
   linear api 'query($id: String!) { issue(id: $id) { team { key } children { nodes { identifier title subIssueSortOrder team { key } state { type } attachments { nodes { url } } } } } }' --variable id=<container>
   ```

   Keep the nodes in the container's team, sort them by `subIssueSortOrder`, lowest first, and pick
   the first slice that passes step 2. Tell the user in one line why you picked it. If none passes,
   stop and report each slice with what blocks it.

2. Check that the slice is ready, before you write anything, the draft included. This applies to a
   slice the user names too.
   - For a named slice, read its state and links:

     ```sh
     linear api 'query($id: String!) { issue(id: $id) { state { type } attachments { nodes { url } } } }' --variable id=<slice>
     ```

   - A slice is merged only when one of its attachment URLs is a pull request and
     `gh pr view <url> --json state` returns `MERGED`. Its Linear status is not proof either way.
   - Read its dependencies with `linear issue relation list <slice>`. Keep the lines of the form
     `<slice> blocked-by <other>`.
   - The slice is ready when it is not merged, its state type is not `canceled`, and every
     `blocked-by` slice is merged or open in one chain. If its state type is `completed` but no
     linked PR is merged, stop and ask the user. If it is not ready for another reason, stop and
     report what blocks it.
   - An unmerged blocker counts only when one of its attachment URLs is a pull request that
     `gh pr view <url> --json state,headRefName,baseRefName` returns as `OPEN`.
   - With no open blocker there is no parent, and the slice starts unstacked. Otherwise call the
     `stack` tool's `chain` action with the URLs of the open blockers as `pullRequests`, and this
     slice's PR as `slicePullRequest` when it has one. On `stop`, stop and report its `reason`.
     Otherwise its `parent` is the parent for step 4.
   - When `branchAbove` is true, ask with `ask_user_question`: wait until the parent merges,
     recommended, or stack on the top of that stack instead. Stacking there makes this slice depend
     on the slices above the parent too. On wait, the slice is not ready. Otherwise the stack's
     `topBranch` becomes the parent.
   - When `git worktree list --porcelain` shows the parent branch checked out in another worktree,
     that worktree owns the stack. Stop, and offer to start the slice there with the
     [handover skill](../handover/SKILL.md).

3. Read the slice with `linear issue view <slice> --json --no-pager`. Note its `branchName`, team,
   and `## Acceptance`. If `$slicedir/start.json` exists, read it and every body file it names. Then
   read the slice's existing agent tickets:

   ```sh
   linear api 'query($id: String!) { issue(id: $id) { children { nodes { identifier title description team { key } project { name } } } } }' --variable id=<slice>
   ```

   When the body file of a ticket that `start.json` records is missing, save the ticket's
   description as the body file. When it differs from the description, either side may hold the
   newer edit: a local edit that never reached Linear, or a Linear edit made after the last start.
   Show the difference and ask with `ask_user_question` which to keep. A kept body file goes to
   Linear through the `start_slice` tool in step 9. To keep Linear's text, save the description as
   the body file.

4. Choose the base. Run `git fetch origin`, then find the remote's default branch.
   `git symbolic-ref --short refs/remotes/origin/HEAD` prints it with the remote prefix, such as
   `origin/main`; the default branch is the part after `origin/`. If that ref is missing, read it
   from `git ls-remote --symref origin HEAD`.
   - Without a parent, the base is the default branch's remote-tracking branch, such as
     `origin/<default branch>`.
   - With a parent from step 2, the slice starts stacked. Fetch the parent with
     `git fetch origin refs/heads/<parent>:refs/remotes/origin/<parent>`. Its base is
     `origin/<parent>`. Its trunk is the `trunk` the `chain` action returned in step 2.

5. Read the code the slice touches in the tree the workers will use: the branch when
   `git rev-parse --verify --quiet refs/heads/<branchName>` finds it, otherwise the base. The
   current checkout may differ, so read without switching: `git ls-tree -r --name-only <tree>` and
   `git show <tree>:<path>`. Agent tickets name real files and tests in that tree.
   - Answer the plan questions in the [structure criteria](../code-quality/structure-criteria.md)
     for the slice's files. Record where each change goes, which existing helper it reuses, and
     which files would grow past 500 lines.
   - When the slice has no structure rules, such as a ticket that never went through brainstorm,
     also answer the module-level questions: which module owns the concept, what would delete
     branches or layers, and which code gets more tangled.

6. Write the draft in `$slicedir`, one body file per agent ticket.
   - `agent-<n>.md`, numbered in work order, with the agent ticket template in the
     [tracker skill](../tracker/SKILL.md). Keep each ticket to one worker task.
   - Put the step 5 answers that apply to the ticket in its `## Files` section.
   - `start.json`:
     `{"version": 1, "slice": "<identifier>", "branch": "<name>", "base": "<ref>", "tickets": [...]}`,
     with one ticket per agent ticket in work order. Each ticket is
     `{"title": "<title>", "file": "agent-<n>.md", "labels": ["<label id>"], "identifier": null}`.
     Take the label IDs from the agent team's label list as the tracker skill says, or use `[]`.
     Leave the identifier `null` until the ticket exists. Keep identifiers that already exist.

   Together the agent tickets must cover every acceptance criterion of the slice.

7. Check the draft.
   - Map each acceptance criterion of the slice to the agent ticket numbers that cover it. When a
     criterion has none, change the draft until every criterion is covered.
   - Judge each `## Acceptance` item in the agent ticket body files. An item passes when it names a
     test, a command, or a manual observation, with its expected result. When the slice or the code
     from step 5 says what to check, rewrite the item. Before step 9, list each item that still
     names no check, with its body file, and tell the user the worker gets it as a vague task. When
     every item passes, say nothing about it. The list never stops step 9 or a worker launch.

8. Check that each new agent ticket is ready for a worker who knows only the ticket. A ticket is new
   when its entry in `start.json` has a `null` identifier. In one turn, launch one fresh `scout` per
   new ticket with the profile's default model. Brief each scout with the path of its body file and
   the tree from step 5, and the plan questions in the
   [structure criteria](../code-quality/structure-criteria.md). Tell it to read its body file with
   `read` and the files the ticket names with `git show <tree>:<path>`. Tell it to search that tree
   with `git grep <pattern> <tree>` and `git ls-tree -r --name-only <tree>` for an existing helper
   the ticket does not name. It lists each question it would ask before starting the work, and its
   answers to the plan questions for the ticket's files, or says it has none.
   - For each question, revise the body file to answer it, or proceed when the ticket or the code
     already answers it. The scout's answer never blocks the start.
   - For each plan answer that changes the ticket's structure, such as a helper to reuse, a file to
     split, or writes that must succeed together, revise its `## Files` section.
   - After a revision, check the draft again as step 7 says.
   - A ticket with no questions and no plan answer to record goes on to step 9 unchanged.
   - A scout that fails to launch or stops without a report does not stop the start. Its ticket goes
     on to step 9 unchanged, and the step 10 report names the failure.

9. Start the slice in this order.
   - Check that `git status --porcelain` prints nothing. If it prints anything, stop and report it.
   - Check that every one of your workers in the worktree is `stopped`, as the
     [stack skill](../stack/SKILL.md) checks before a switch. If one is not, stop and report it.
   - For a stacked start, create the branch on the parent with step 2 of the stack skill, passing
     the trunk from step 4. If it stops, report what it found and stop.
   - Otherwise create the branch with `git switch --no-track -c <branchName> <base>`. If
     `git rev-parse --verify --quiet refs/heads/<branchName>` shows it exists already, run
     `git switch <branchName>` instead.
   - Move the slice to In Progress as the tracker skill says.
   - Call the `start_slice` tool's `read` action with `directory` set to `$slicedir`, and
     `agentTeam` set to the team in the `Tracker agent team:` line. If `problems` is not empty,
     report each one and stop. Otherwise call `apply` with the `stateToken` from `read`. On an
     error, stop and report it with the steps it says completed. When `apply` returns
     `status: declined`, the user refused the writes: stop, and report that nothing was written and
     which tickets were left unchanged.

10. Report the start in about 30 lines, without raw commands:
    - The slice, with the reason you picked it.
    - The branch, its base, and whether the branch existed already. For a stacked start, name the
      parent's slice and PR, the trunk, and that the PR will target the parent branch. Name any
      dependency that stacking on the top of the parent's stack added.
    - Each agent ticket with the `status` that `apply` returned (`new`, `updated`, or `unchanged`),
      its identifier, URL, title, and one line from its `## Outcome`.
    - Each new agent ticket's scout questions from step 8, each with whether you revised the ticket
      or proceeded, and each scout that failed.
    - Each acceptance criterion of the slice, with the agent ticket numbers that cover it.

11. Run the slice in this order.
    - Delegate each agent ticket to a worker, and pass the path of its body file, such as
      `$slicedir/agent-1.md`, in the task. Copy each item of its `## Acceptance` word for word, in
      order, into the launch's `acceptance` array.
    - After the last worker reports, ask once with `ask_user_question` whether to run code-quality
      before code-review.
    - On yes, run the [code-quality skill](../code-quality/SKILL.md) on the slice branch, and pass
      it the slice as the ticket under review. Then go on to code-review. On no, go on to
      code-review.
    - For a stacked slice, give code-quality a branch diff from `git merge-base <base> HEAD`, with
      the base from step 4, so it reviews only this slice's diff.
    - When the code-review skill's ownership rule finds the slice branch the user's own, let
      code-quality continue into its triage without asking. This applies to a reused branch too.
    - Review the change with the [code-review skill](../code-review/SKILL.md), and pass it the slice
      as the ticket under review. Ask it for a full review, so it covers the whole slice and not
      only the code-quality fixes. When its ownership rule finds the slice branch the user's own,
      let the review continue into fixing its findings without asking. This applies to a reused
      branch too.
    - Then audit the slice with the [finish-slice skill](../finish-slice/SKILL.md). When that audit
      created fix agent tickets, delegate each one as the first bullet above says, then audit again
      once. Items still not met go on to the pr skill, which shows them as required actions.
    - Then open the PR with the [pr skill](../pr/SKILL.md). Link the slice from the PR as the
      tracker skill says.

## Changes after the start

- You may add an agent ticket inside the slice's outcome. Write its body file and its entry in
  `start.json`, judge its acceptance items as step 7 says, and create it as in step 9. Report it
  with its identifier, URL, and one line of reason.
- Work beyond the slice's outcome is a new slice. Re-plan it with the
  [slice skill](../slice/SKILL.md).
