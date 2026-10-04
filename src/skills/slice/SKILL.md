---
name: slice
description:
  Split an agreed design into ordered, PR-sized slice tickets under a container ticket in Linear.
  Drafts the tickets, previews the layout and every Linear write for approval, then creates them in
  order. Use it for "slice this design", "plan the slices", "break this into sub-tickets", or "plan
  this as PR-sized pieces". It does not split existing commits or a finished branch.
metadata:
  required-for:
    creating or re-planning slice sub-tickets for a design in Linear, including as a step in a
    larger task
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

- Follow the [tracker skill](../tracker/SKILL.md)'s hard rules on preview approval and on questions.
- Do not create agent tickets, start a slice, create branches, stack PRs, or change any ticket's
  status. Never change or reorder a merged slice.
- If a step fails partway, stop and report what completed. Before you retry anything, read the
  draft, and the container's children when the container exists.
- Before you save the first file, create the draft directory inside an ignored `.tau/` from the
  repository root. Pick `<id>` in this order:
  - For an existing container, search `.tau/slices/*/plan.md` for its identifier. When one matches,
    reuse that directory as `<id>`.
  - Otherwise use the container's identifier in lower case, such as `eng-123`.
  - For a container that does not exist yet, use a short slug of its title with only `a-z`, `0-9`,
    and `-`.

  Stop unless the command prints `slicedir=`. Use the printed path as `$slicedir` for every file you
  save. Never write scratch files to `/tmp` or another shared path.

  ```sh
  ! [ -L .tau ] && ! [ -L .tau/slices ] && ! [ -L .tau/slices/<id> ] && ! [ -L .tau/.gitignore ] &&
    mkdir -p .tau/slices/<id> &&
    { grep -qsx '\*' .tau/.gitignore || printf '\n*\n' >> .tau/.gitignore; } &&
    git check-ignore -q .tau/slices/<id>/plan.md && echo "slicedir=.tau/slices/<id>"
  ```

## Procedure

1. Read the design from the Linear ticket, file, or conversation the user names. For a ticket, run
   `linear issue view <id> --json --no-pager`. Route the container and its slices with the
   [tracker skill](../tracker/SKILL.md), which stops when an existing container is in another team
   or project. Ask once whether the design is agreed. If it is not, stop.

2. Read the current state.
   - If `$slicedir/plan.md` exists, read it and every body file it names.
   - If the container exists, read its current description with
     `linear issue view <container> --json --no-pager`, even when the design came from elsewhere.
     Then read its children with this children query:

     ```sh
     linear api 'query($id: String!) { issue(id: $id) { children { nodes { identifier title description subIssueSortOrder team { key } project { name } state { type } attachments { nodes { url } } } } } }' --variable id=<container>
     ```

   - Sort the nodes by `subIssueSortOrder`, lowest first.
   - A slice is merged only when one of its attachment URLs is a pull request and
     `gh pr view <url> --json state` returns `MERGED`. Its Linear status is not proof either way. If
     a slice's state type is `completed` but no linked PR is merged, stop and ask the user.
   - For each slice that exists, read its dependencies with `linear issue relation list <slice>`.
     Keep the lines of the form `<slice> blocked-by <other>`.

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

4. Write the draft in `$slicedir`, one body file per ticket. Before you write each new ticket, the
   container and every new slice, search for an open duplicate, then write its title and body.
   Follow the [tracker skill](../tracker/SKILL.md) for both.
   - `container.md`: the container's full description, with the agreed design in its `## Design`
     section. For an existing container, keep all text outside that section unchanged.
   - `slice-<n>.md`, numbered in plan order.
   - `plan.md`: the container's identifier, then one row per slice with its number, title, body
     file, `blocked-by` numbers, and Linear identifier. Leave the identifier empty until the ticket
     exists. Keep it for each slice that exists, even when the plan renames or renumbers the slice.

   For a design with one slice, write `ticket.md` instead of `container.md` and `slice-1.md`, as the
   slice template describes.

5. Preview and ask. Show what the user decides on, not how step 6 runs it. Keep it to about 40
   lines, and leave out raw commands and details of the local environment.
   - The Linear layout as an ASCII tree with aligned columns. Mark each ticket as `new`, `update`,
     or `unchanged`, and give each slice its `blocked-by` numbers and rough size in changed lines.
     Under each slice, add one line on what it delivers and one line from its `## Out of scope`:

     ```text
     ENG-120  update  Add PR-sized planning
     ├─ 1     new     Record the lifecycle                   ~150
     │                The decision record for the slice lifecycle.
     │                Out of scope: the skill itself.
     └─ 2     new     Add the slice skill    blocked-by 1    ~300
                      The /slice skill and its tests.
                      Out of scope: starting a slice.
     ```

   - When the slices branch or join, a `flowchart TD` of the `blocked-by` edges, drawn with the
     [diagram skill](../diagram/SKILL.md) as a top-level block after the tree. Keep the tree; it
     holds the status, size, and scope a flowchart cannot.
   - One line of reason for each dependency, or missing dependency, that is not obvious.
   - Each acceptance criterion of the design, with the slice numbers that cover it.
   - Each choice in the `## Design` section that the agreed design did not already state, one line
     each, and the path of the draft that holds the full section. For an existing container, say
     that the text outside that section stays unchanged.
   - The Linear writes step 6 will make, in order and numbered, one line each, such as
     `Create slices 1-3 under ENG-120` or `Mark 2 blocked by 1`. Say that step 7 may fix the order
     of the slices, and that created tickets stay in Linear until the user cancels them by hand.
   - On a later run, what the draft changes compared with Linear now, including `blocked-by`
     relations to add and remove. Slices dropped from the plan stay in Linear: list them for the
     user to cancel by hand.

   Approve with `ask_user_question` and give the number of writes in the question: approve, change
   the plan, or stop. After any change, write the draft again and show a new preview.

6. Write to Linear in the previewed order, with the commands in the
   [tracker skill](../tracker/SKILL.md).
   - Create the container from `$slicedir/container.md` when it does not exist. Record its
     identifier in `plan.md`, then move `$slicedir` to `.tau/slices/<identifier in lower case>` and
     use the new path. When the retry search finds the container, record its identifier and move
     `$slicedir` the same way. When the container exists, update its description.
   - Create each missing slice in order under the container, from `$slicedir/slice-<n>.md`.
   - Update the title and body of a changed slice that is not merged.
   - Add each new `blocked-by` relation to a slice that is not merged, and remove each one the plan
     drops.

   After each command that creates a ticket, record its identifier in `$slicedir/plan.md` at once.
   If the output shows no identifier, stop. Before any retry, search as the tracker skill says: the
   team for the container or a one-slice ticket, the container's children for a slice. On a retry,
   skip each slice that has an identifier in the draft or a child with the same title that fits, and
   record that child's identifier. A child fits when its team and project, read with the children
   query, match the route. Report a same-title child that does not fit, and stop.

   For a design with one slice, create or update only that ticket from `$slicedir/ticket.md`, and
   skip the dependencies and step 7.

7. Check the order. Read the children again with the children query. If sorting by
   `subIssueSortOrder` does not give the plan order, move each unmerged slice that is out of place
   to a value between its neighbors in the plan with the tracker skill, then read the children
   again. Repair once; if the order is still wrong, report it. Merged slices keep their place.

8. Report the container and each slice with its identifier and URL, in order, and any slice the user
   should cancel by hand. For a design with one slice, report that ticket alone.
