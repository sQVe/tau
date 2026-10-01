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

- Follow the lifecycle and ticket rules in
  [ADR 0075](../../docs/adr/0075-plan-work-as-pr-sized-slices-in-linear.md).
- Before the user approves the preview, only read. You may run `git fetch`, but create or switch no
  branch and write nothing to Linear. Any change after approval needs a new preview.
- Ask every question with the `ask_user_question` tool, including the preview approval. Never end a
  turn with a question in prose.
- Take the agent team only from the prompt line that starts with
  `The agent team for slice agent tickets is`. If that line is missing, or says the team could not
  be read, stop. Tell the user to set `slice.agentTeam` to a Linear team key in
  `~/.pi/agent/tau.json`, and show any error the line gives. Never guess a team.
- Do not change any ticket's status, and never change a merged slice.
- If a step fails partway, stop and report what completed. Read the draft and the slice's children
  before you retry anything.
- Before you save the first file, create the draft directory inside an ignored `.tau/` from the
  repository root. Use the slice's identifier in lower case as `<id>`, such as `eng-123`. Stop
  unless it prints `slicedir=`, and use the printed path as `$slicedir` for every file you save.
  Never write scratch files to `/tmp` or another shared path.

  ```sh
  ! [ -L .tau ] && ! [ -L .tau/slices ] && ! [ -L .tau/slices/<id> ] && ! [ -L .tau/.gitignore ] &&
    mkdir -p .tau/slices/<id> &&
    { grep -qsx '\*' .tau/.gitignore || printf '\n*\n' >> .tau/.gitignore; } &&
    git check-ignore -q .tau/slices/<id>/start.md && echo "slicedir=.tau/slices/<id>"
  ```

## Procedure

1. Pick the slice. If the user names no ticket, ask for one. A container is a ticket with children
   in its own team; those children are its slices. Any other ticket the user names is the slice
   itself, including a one-slice design with no container. For a container, read its slices in
   sub-issue order:

   ```sh
   linear api 'query($id: String!) { issue(id: $id) { team { key } children { nodes { identifier title subIssueSortOrder team { key } state { type } attachments { nodes { url } } } } } }' --variable id=<container>
   ```

   Sort the nodes by `subIssueSortOrder`, lowest first, and pick the first slice that passes step 2.
   Tell the user in one line why you picked it. If none passes, stop and report each slice with what
   blocks it.

2. Check that the slice is ready, before you draft or write anything. This applies to a slice the
   user names too. For a named slice, read its state and links:

   ```sh
   linear api 'query($id: String!) { issue(id: $id) { state { type } attachments { nodes { url } } } }' --variable id=<slice>
   ```

   A slice is merged only when one of its attachment URLs is a pull request and
   `gh pr view <url> --json state` returns `MERGED`. Its Linear status is not proof either way. Read
   its dependencies with `linear issue relation list <slice>`, and keep the lines of the form
   `<slice> blocked-by <other>`. The slice is ready when it is not merged, its state type is not
   `canceled`, and every `blocked-by` slice is merged. Otherwise stop and report what blocks it.

3. Read the slice with `linear issue view <slice> --json --no-pager`. Note its `branchName`, team,
   and `## Acceptance`. If `$slicedir/start.md` exists, read it and every body file it names. Read
   the slice's existing agent tickets:

   ```sh
   linear api 'query($id: String!) { issue(id: $id) { children { nodes { identifier title team { key } } } } }' --variable id=<slice>
   ```

4. Choose the base. Run `git fetch origin`, then use the remote's default branch from
   `git symbolic-ref --short refs/remotes/origin/HEAD`, such as `origin/main`.

5. Read the code the slice touches. Agent tickets are written against the code as it is now, so name
   real files and tests.

6. Write the draft in `$slicedir`, one body file per agent ticket.
   - `agent-<n>.md`, numbered in work order: `## Outcome`, `## Files`, `## First test`, and
     `## Acceptance` with checkboxes. Keep each ticket to one worker task. A cheap worker model
     needs the files, the first test, and the acceptance checks named exactly.
   - `start.md`: the slice identifier, the branch, the base, and one row per agent ticket with its
     number, title, body file, and Linear identifier. Keep identifiers that already exist. Leave
     them empty until the ticket exists.

   Together the agent tickets must cover every acceptance criterion of the slice.

7. Preview and ask. Keep it to about 30 lines, without raw commands:
   - The slice, with the reason you picked it.
   - The branch, its base, and whether the branch exists already.
   - Each agent ticket as `new` or `unchanged`, with its title and one line from its `## Outcome`.
   - Each acceptance criterion of the slice, with the agent ticket numbers that cover it.
   - The writes step 8 makes, numbered, one line each, such as
     `Create agent tickets 1-3 under ENG-123 in AI` or
     `Create branch eng-123-add-x from origin/main`.

   Approve with `ask_user_question`: approve, change the plan, or stop. After any change, write the
   draft again and show a new preview.

8. Start the slice in the previewed order.
   - Check that `git status --porcelain` prints nothing. If it prints anything, stop and report it.
   - Create the branch with `git switch --no-track -c <branchName> <base>`. If
     `git rev-parse --verify --quiet refs/heads/<branchName>` shows it exists already, run
     `git switch <branchName>` instead.
   - Create each agent ticket:
     `linear issue create --team <agent team> --parent <slice> --title "<title>" --description-file $slicedir/agent-<n>.md --no-interactive`.
     After each one, record its identifier in `$slicedir/start.md` at once. If the output shows no
     identifier, stop and read the slice's children before any retry. On a retry, skip each agent
     ticket that has an identifier in the draft or a child with the same title, and record that
     child's identifier.

9. Report the branch and each agent ticket with its identifier and URL.

10. Hand off to the usual flow. Delegate each agent ticket to a worker, and pass the path of its
    body file, such as `$slicedir/agent-1.md`, in the task. Review the change with the
    [code-review skill](../code-review/SKILL.md), then open the PR with the
    [pr skill](../pr/SKILL.md). The PR body says `Fixes <slice>`.

## Changes after the start

- You may add an agent ticket inside the slice's approved outcome without a new preview. Write its
  body file, add its row to `start.md`, create it as in step 8, and tell the user one line of
  reason.
- Work beyond the slice's outcome is a new slice. Re-plan it with the
  [slice skill](../slice/SKILL.md).
