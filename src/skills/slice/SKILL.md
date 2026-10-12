---
name: slice
description:
  Split an agreed design into ordered, PR-sized slice tickets under a container ticket in Linear.
  Drafts the tickets, checks them, creates them in order, and reports the layout. Use it for "slice
  this design", "plan the slices", "break this into sub-tickets", or "plan this as PR-sized pieces".
  It does not split existing commits or a finished branch.
metadata:
  required-for:
    creating or re-planning slice sub-tickets for a design in Linear, including as a step in a
    larger task
---

# Slice

## When to use

Use this skill to plan an agreed design as slices in Linear. Each slice becomes one branch and one
PR. Run it again on the same design to change the plan. It needs the `linear` CLI authenticated for
the workspace.

Do not use it to guide the design conversation, or to split commits or a branch that already exist.

## Goal

The container ticket holds a short summary and one line per key decision. Each slice holds the
design it follows in its Design section. The container has one sub-ticket per slice, in order, with
`blocked-by` relations only for real dependencies.

## Hard rules

- Follow the [tracker skill](../tracker/SKILL.md)'s hard rules on writes and on questions. Write the
  plan to Linear without asking the user to approve it.
- Do not create agent tickets, start a slice, create branches, or stack PRs. Change no ticket's
  status, except cancelling a dropped slice after the user approves it in step 8. Never change or
  reorder a merged slice.
- Use the `slice` tool for the draft directory, for reading the container and its slices, and for
  every write to them other than a cancellation. Save drafts only in the directory the tool returned
  last, since `apply` moves the draft after it creates the container.
- If `apply` fails, stop and report the steps it applied and the steps it did not. Before any retry,
  follow the tool's recovery steps for that error, including a ticket whose identifier was not
  saved.

## Procedure

1. Read the design from the Linear ticket, file, or conversation the user names. For a ticket, run
   `linear issue view <id> --json --no-pager`. When the user names no source and no container
   exists, read `design.md` in the draft directory that step 2 returns, such as one the
   [brainstorm skill](../brainstorm/SKILL.md) wrote. Once `plan.json` records a container
   identifier, read the design from Linear and ignore later edits to `design.md`. Route the
   container and its slices with the [tracker skill](../tracker/SKILL.md), which stops when an
   existing container is in another team or project. Ask no question about whether the design is
   agreed.

2. Read the current state. Call `slice` with `prepare`, then with `read`.
   - Use the draft it returns as the last plan, and the container's description and children as
     Linear now, even when the design came from elsewhere.
   - Show each entry in `problems` and ask the user how to resolve it. Never call `apply` while
     `problems` is not empty.

3. Split the design into slices.
   - Each slice leaves `main` working and fits one review sitting, ideally a few hundred changed
     lines.
   - Put groundwork, such as refactors or new helpers, in an earlier slice.
   - Prefer thin slices that deliver real behavior over layers that deliver nothing until the last
     one.
   - Use one slice only when the work cannot split, and say why. Then the ticket is the slice, and
     there is no container.
   - Mark a slice `blocked-by` another only when it cannot work or merge without it.
   - Give every slice a title that no other slice in the plan uses.

4. Write the draft in the directory, one body file per ticket. Before you write each new ticket, the
   container and every new slice, search for an open duplicate with the
   [tracker skill](../tracker/SKILL.md).
   - `container.md`: the container's full description in the
     [container template](../tracker/templates/container.md): a short summary and one line per key
     decision in `## Decisions`, not the full design. For an existing container, keep all text
     outside the changed sections unchanged.
   - `slice-<n>.md`, numbered in plan order, in the [slice template](../tracker/templates/slice.md),
     with the rules the slice follows in its `## Design`.
   - `plan.json`: the route from the tracker skill, the container, and the slices in plan order.
     Keep the identifier of each ticket that exists, even when the plan renames or renumbers it.

   For a design with one slice, write `ticket.md` as the container's file, as the slice template
   describes, and list no slices.

   Then call `read` again. Resolve its `problems` as in step 2.

5. Check the plan. Map each acceptance criterion of the design to the slice numbers that cover it.
   When a criterion has none, change the draft and call `read` again.

6. Call `slice` with `apply` for the last read, without asking the user.
   - When it says the state changed, call `read` again, resolve its `problems` as in step 2, and
     apply again.
   - When it returns `unchanged`, report that Linear already matches the plan.
   - When `orderInPlace` is false, report that the slice order is still wrong.

7. Report what you wrote. Keep it to about 40 lines, and leave out raw commands and details of the
   local environment.
   - The Linear layout in the [report template](templates/report.md), with each ticket's identifier
     and URL, or the one ticket of a one-slice design.
   - When the slices branch or join, a `flowchart TD` of the `blocked-by` edges, drawn with the
     [diagram skill](../diagram/SKILL.md) as a top-level block after the tree. Keep the tree; it
     holds the status, size, and scope a flowchart cannot.
   - One line of reason for each dependency, or missing dependency, that is not obvious.
   - Each acceptance criterion of the design, with the slice numbers that cover it.
   - Each choice in the decisions or slice designs that the agreed design did not already state, one
     line each, and the path of the draft that holds it. For an existing container, say that the
     text outside the changed sections stayed unchanged.
   - On a later run, each write from the `applied` list that `apply` returned, including
     `blocked-by` relations added and removed and each move of an existing slice into plan order.
     `apply` finds some of those moves only after its updates, so the `writes` of the last `read` do
     not list them.

8. Ask with `ask_user_question` which `dropped` slices that are not merged or completed to cancel,
   by identifier and title. A dropped slice stays in Linear until it is cancelled. Cancel the chosen
   ones with the [tracker skill](../tracker/SKILL.md), and report which were cancelled and which
   were kept.
