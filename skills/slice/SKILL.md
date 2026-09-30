---
name: slice
description:
  Split an agreed design into ordered, PR-sized slice tickets under a container ticket in Linear.
  Drafts the tickets, previews the layout and the exact `linear` commands for approval, then creates
  them in order. Use it for "slice this design", "plan the slices", "break this into sub-tickets",
  or "plan this as PR-sized pieces". It does not split existing commits or a finished branch.
---

# Slice

## When to use

Use this skill after the user and the manager agree on a design, to plan the work as slices in
Linear. Each slice becomes one branch and one PR. Run it again on the same design to change the
plan. It needs the `linear` CLI authenticated for the workspace.

Do not use it to guide the design conversation, or to split commits or a branch that already exist.

## Goal

The container ticket holds the agreed design in its Design section. It has one sub-ticket per slice,
in order, with `blocked-by` relations only for real dependencies. The user approved the layout
before anything was written to Linear.

## Hard rules

- Follow the lifecycle and ticket rules in
  [ADR 0073](../../docs/adr/0073-plan-work-as-pr-sized-slices-in-linear.md).
- Write to Linear only after the user approves the preview. Any change after approval needs a new
  preview.
- Ask every question with the `ask_user_question` tool, including the preview approval. Never end a
  turn with a question in prose.
- Do not create agent tickets, start a slice, create branches, stack PRs, or change any ticket's
  status. Never change or reorder a merged slice.
- If a step fails partway, stop and report what completed. Read the draft and the container's
  children before you retry anything.
- Before you save the first file, create the draft directory inside an ignored `.tau/` from the
  repository root. Use the container's identifier in lower case as `<id>`, such as `eng-123`. For a
  container that does not exist yet, use a short slug of its title with only `a-z`, `0-9`, and `-`.
  Stop unless it prints `slicedir=`, and use the printed path as `$slicedir` for every file you
  save. The directory is fixed, so a later run finds the same draft. Never write scratch files to
  `/tmp` or another shared path.

  ```sh
  ! [ -L .tau ] && ! [ -L .tau/slices ] && ! [ -L .tau/slices/<id> ] && ! [ -L .tau/.gitignore ] &&
    mkdir -p .tau/slices/<id> &&
    { grep -qsx '\*' .tau/.gitignore || printf '\n*\n' >> .tau/.gitignore; } &&
    git check-ignore -q .tau/slices/<id>/plan.md && echo "slicedir=.tau/slices/<id>"
  ```

## Procedure

1. Read the design from the Linear ticket, file, or conversation the user names. For a ticket, run
   `linear issue view <id> --json --no-pager` and note its team and project. Ask once whether the
   design is agreed. If it is not, stop.

2. Read the current state. If `$slicedir/plan.md` exists, read it and every body file it names. If
   the container exists, read its current description with
   `linear issue view <container> --json --no-pager`, even when the design came from elsewhere, and
   read its children in sub-issue order:

   ```sh
   linear api 'query($id: String!) { issue(id: $id) { children { nodes { identifier title subIssueSortOrder branchName } } } }' --variable id=<container>
   ```

   Sort the nodes by `subIssueSortOrder`, lowest first. A slice is merged only when
   `gh pr list --head <branchName> --state merged --json number` lists a PR. Its Linear status is
   not proof either way. For each slice that exists, read its dependencies with
   `linear issue relation list <slice>` and keep the lines of the form `<slice> blocked-by <other>`.

3. Split the design into slices.
   - Each slice leaves `main` working and fits one review sitting, ideally a few hundred changed
     lines.
   - Put groundwork, such as refactors or new helpers, in an earlier slice.
   - Prefer thin slices that deliver real behavior over layers that deliver nothing until the last
     one.
   - Use one slice only when the work cannot split, and say why. Then the ticket is the slice, and
     there is no container.
   - Mark a slice `blocked-by` another only when it cannot work or merge without it.
   - Give every slice a title that no other slice in the plan uses. A retry matches tickets by
     title.

4. Write the draft in `$slicedir`, one body file per ticket.
   - `container.md`: the container's full description, with the agreed design in its `## Design`
     section. For an existing container, keep all text outside that section unchanged.
   - `slice-<n>.md`, numbered in plan order: `## Goal`, `## Delivers`, `## Out of scope`, and
     `## Acceptance` with checkboxes.
   - `plan.md`: one row per slice with its number, title, body file, `blocked-by` numbers, and
     Linear identifier. Leave the identifier empty until the ticket exists.

5. Preview and ask. Show:
   - The Linear layout as an ASCII tree with aligned columns. Mark each ticket as `new`, `update`,
     or `unchanged`:

     ```text
     ENG-120  update     Add PR-sized planning          container
     ├─ 1     new        Record the lifecycle
     ├─ 2     new        Add the slice skill            blocked-by 1
     └─ 3     new        Add the start skill
     ```

   - A table with one row per slice: number, title, what it delivers, rough size, and `blocked-by`.
   - The exact `## Design` section that step 6 writes into the container, or into the ticket for a
     design with one slice, quoted in full from the draft.
   - The exact `linear` commands step 6 will run, in order, with file paths.
   - On a later run, what changed since the last approved plan, including `blocked-by` relations to
     add and remove. Slices dropped from the plan stay in Linear: list them for the user to cancel
     by hand.

   Approve with `ask_user_question`: approve, change the plan, or stop. After any change, write the
   draft again and show a new preview.

6. Write to Linear in the previewed order. After each command that creates a ticket, record its
   identifier in `$slicedir/plan.md` at once. If the output shows no identifier, stop, and read the
   container's children before any retry. On a retry, skip each slice that has an identifier in the
   draft or a child with the same title, and record that child's identifier.
   - Create the container when it does not exist:
     `linear issue create --team <team> --project <project> --title "<title>" --description-file $slicedir/container.md --no-interactive`.
   - Otherwise update its description:
     `linear issue update <container> --description-file $slicedir/container.md`.
   - Create each missing slice in order:
     `linear issue create --team <team> --project <project> --parent <container> --title "<title>" --description-file $slicedir/slice-<n>.md --no-interactive`.
   - Update a changed slice that is not merged:
     `linear issue update <slice> --title "<title>" --description-file $slicedir/slice-<n>.md`.
   - Add each new dependency: `linear issue relation add <slice> blocked-by <earlier slice>`.
   - Remove each dependency the plan drops from a slice that is not merged:
     `linear issue relation delete <slice> blocked-by <other>`.

   For a design with one slice, create or update that one ticket with its design and slice body, and
   skip the container, the dependencies, and step 7.

7. Check the order. Read the children again with the query in step 2. If sorting by
   `subIssueSortOrder` does not give the plan order, move each unmerged slice that is out of place
   to a value between its neighbors in the plan, then read the children again. Merged slices keep
   their place:

   ```sh
   linear api 'mutation($id: String!, $order: Float!) { issueUpdate(id: $id, input: { subIssueSortOrder: $order }) { success } }' --variable id=<slice> --variable order=<value>
   ```

8. Report the container and each slice with its identifier and URL, in order, and any slice the user
   should cancel by hand. For a design with one slice, report that ticket alone.

## See also

- [ADR 0073: Plan work as PR-sized slices in Linear](../../docs/adr/0073-plan-work-as-pr-sized-slices-in-linear.md)
- [pr skill](../pr/SKILL.md) for the PR that ships each slice
