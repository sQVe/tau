---
name: start-slice
description:
  Start one slice of a planned design. Creates its branch and its agent tickets in Linear, then
  delegates the work. Picks the next slice from order, dependencies, and merge state, and previews
  the branch, base, and agent tickets for one approval. Use it for "start the next slice", "start
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
the agent team. The user approved the start once, before anything was written to Linear or Git.
Workers then carry out the agent tickets.

## Hard rules

- Before the user approves the preview, write only the draft in `$slicedir`. You may run
  `git fetch`, but create or switch no branch and write nothing to Linear. Any change to the
  approved plan needs a new preview, an added agent ticket included.
- Route, write, and create agent tickets with the [tracker skill](../tracker/SKILL.md), and follow
  its hard rules on questions and status. The one status change is moving the slice to In Progress
  in step 8.
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
   the slice or container, and name it in the step 7 preview. Ask when none or several fit.
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
     `gh pr view <url> --json state,headRefName,baseRefName` returns as `OPEN`. Run the GitHub reads
     of the [stack skill](../stack/SKILL.md)'s stack check on each such PR's branch.
   - Open blockers are in one chain when one GitHub stack holds them all, or when only one blocker
     is open. The parent is the open blocker highest in that stack. Stop and report when open
     blockers sit in different stacks, or when several are open and no stack holds them.
   - When an open PR other than this slice's is based on the parent, or the parent's GitHub stack
     lists a PR above it, the parent already has a branch above it. A stack cannot fork. When no
     GitHub stack holds that PR, stop and report the chain. Otherwise ask with `ask_user_question`:
     wait until the parent merges, recommended, or stack on the top of that stack instead. Stacking
     there makes this slice depend on the slices above the parent too. On wait, the slice is not
     ready. Otherwise that top branch becomes the parent.
   - When `git worktree list --porcelain` shows the parent branch checked out in another worktree,
     that worktree owns the stack. Stop, and offer to start the slice there with the
     [handover skill](../handover/SKILL.md).

3. Read the slice with `linear issue view <slice> --json --no-pager`. Note its `branchName`, team,
   and `## Acceptance`. If `$slicedir/start.md` exists, read it and every body file it names. Then
   read the slice's existing agent tickets:

   ```sh
   linear api 'query($id: String!) { issue(id: $id) { children { nodes { identifier title description team { key } project { name } } } } }' --variable id=<slice>
   ```

   Linear holds the body of each agent ticket that exists. Add a row with its identifier to
   `start.md` for one that has no row, if it fits as step 8 says. Report one that does not fit, and
   stop. When its body file is missing or differs, save its description as the body file, so the
   worker gets the same task as the ticket.

4. Choose the base. Run `git fetch origin`, then find the remote's default branch.
   `git symbolic-ref --short refs/remotes/origin/HEAD` prints it with the remote prefix, such as
   `origin/main`; the default branch is the part after `origin/`. If that ref is missing, read it
   from `git ls-remote --symref origin HEAD`.
   - Without a parent, the base is the default branch's remote-tracking branch, such as
     `origin/<default branch>`.
   - With a parent from step 2, the slice starts stacked. Fetch the parent with
     `git fetch origin refs/heads/<parent>:refs/remotes/origin/<parent>`. Its base is
     `origin/<parent>`. Its trunk is the base of the bottom PR in the parent's GitHub stack, or the
     default branch when no stack holds the parent.

5. Read the code the slice touches in the tree the workers will use: the branch when
   `git rev-parse --verify --quiet refs/heads/<branchName>` finds it, otherwise the base. The
   current checkout may differ, so read without switching: `git ls-tree -r --name-only <tree>` and
   `git show <tree>:<path>`. Agent tickets name real files and tests in that tree.

6. Write the draft in `$slicedir`, one body file per agent ticket.
   - `agent-<n>.md`, numbered in work order, with the agent ticket template in the
     [tracker skill](../tracker/SKILL.md). Keep each ticket to one worker task.
   - `start.md`: the slice identifier, the branch, the base, and one row per agent ticket with its
     number, title, body file, and Linear identifier. Leave the identifier empty until the ticket
     exists. Keep identifiers that already exist.

   Together the agent tickets must cover every acceptance criterion of the slice.

7. Preview and ask. Keep it to about 30 lines, without raw commands:
   - The slice, with the reason you picked it.
   - The branch, its base, and whether the branch exists already. For a stacked start, name the
     parent's slice and PR, the trunk, and that the PR will target the parent branch. Name any
     dependency that stacking on the top of the parent's stack adds.
   - Each agent ticket as `new` or `unchanged`, with its title and one line from its `## Outcome`.
   - Each acceptance criterion of the slice, with the agent ticket numbers that cover it.
   - The writes step 8 makes, numbered, one line each, such as
     `Create branch eng-123-add-x from origin/<default branch>`,
     `Create branch eng-124-add-y on eng-123-add-x with gh stack`, `Move ENG-123 to In Progress`, or
     `Create agent tickets 1-3 under ENG-123 in AI`.

   Approve with `ask_user_question`: approve, change the plan, or stop. After any change, write the
   draft again and show a new preview.

8. Start the slice in the previewed order.
   - Check that `git status --porcelain` prints nothing. If it prints anything, stop and report it.
   - Check that every one of your workers in the worktree is `stopped`, as the
     [stack skill](../stack/SKILL.md) checks before a switch. If one is not, stop and report it.
   - For a stacked start, create the branch on the parent with step 2 of the stack skill, passing
     the trunk from step 4. If it stops, report what it found and stop.
   - Otherwise create the branch with `git switch --no-track -c <branchName> <base>`. If
     `git rev-parse --verify --quiet refs/heads/<branchName>` shows it exists already, run
     `git switch <branchName>` instead.
   - Move the slice to In Progress as the tracker skill says.
   - Create each agent ticket under the slice in the agent team, with the tracker skill's command
     for agent tickets.

     After each one, record its identifier in `$slicedir/start.md` at once. If the output shows no
     identifier, stop and read the slice's children before any retry. On a retry, skip each agent
     ticket that has an identifier in the draft or a child with the same title that fits, and record
     that child's identifier. A child fits when it is in the agent team with no project, as the
     tracker skill routes agent tickets. Report a same-title child that does not fit, and stop.

9. Report the branch and each agent ticket with its identifier and URL.

10. Delegate each agent ticket to a worker, and pass the path of its body file, such as
    `$slicedir/agent-1.md`, in the task. Review the change with the
    [code-review skill](../code-review/SKILL.md). When the code-review skill's ownership rule finds
    the slice branch the user's own, let the review continue into fixing its findings without
    asking. This applies to a reused branch too. Then open the PR with the
    [pr skill](../pr/SKILL.md). Link the slice from the PR as the tracker skill says.

## Changes after the start

- You may add an agent ticket inside the slice's approved outcome. Write its body file and its row
  in `start.md`. Preview it as the tracker skill says, with one line of reason, and create it as in
  step 8 only after the user approves.
- Work beyond the slice's outcome is a new slice. Re-plan it with the
  [slice skill](../slice/SKILL.md).
