---
name: worktree
description:
  Create or open a Git worktree for a ticket or task with Grove and open it as a herdr-app space.
  Use it when asked to create, add, start, or open a worktree, optionally followed by a handover.
metadata:
  required-for: creating a Git worktree
---

# Worktree

## When to use

Use this skill when the user asks for a worktree for a ticket or a piece of work. When you work from
the bare repository root, an approved implementation task is such a request: create the worktree and
hand the task over to it. Otherwise, agreeing to a change is not a request for a worktree. Grove
creates the worktree and runs the repository's add hooks, such as dependency installs.

## Hard rules

- For an implementation handover, check before `grove add` that the work is ready, as the
  [handover skill](../handover/SKILL.md) defines it. Create no worktree while anything is open,
  unless the user says to plan in it.
- Creating a worktree does not start work. Do not change the ticket's status unless the user asks.
  Do not start the work in the new worktree yourself. It belongs to the agent in that space.
- Report a failed `grove add` before retrying or handing off. Do not work around it with
  `grove switch`, `--no-fetch`, or `--no-hooks`. A refusal because the branch already has a worktree
  is not a failure; step 2 says how to handle it.

## Procedure

1. Choose the branch, in this order:
   - The branch the user names.
   - For a ticket, its Linear branch name from `linear issue view <ID> --json --no-pager`. Pass
     `--workspace <slug>` when the ticket lives outside the default workspace.
   - If Linear has none, or there is no ticket, a descriptive kebab-case name from the ticket ID and
     title, or from the task.
2. Run `grove add <branch> --name <lowercase-ticket-id>` from the repository.
   - Omit `--name` without a ticket.
   - Pass `--base <base>` only for a new branch whose base the user or project names. Otherwise
     Grove uses the default branch. Grove rejects `--base` for an existing branch.
   - If the branch already has a worktree, Grove refuses with
     `worktree already exists for branch "<branch>" at <path>` and creates nothing. Use that
     `<path>` as the checkout in step 3.
3. Open the worktree as a space. Reuse the space whose folder is the checkout in `herdr-app ls`, and
   show it with `herdr-app do space.select --id <id>`. Otherwise run
   `herdr-app do space.new --name <ticket or branch> --folder <checkout>`.
4. Send a handover to the new space with the [handover skill](../handover/SKILL.md) when the user
   asked for one. From the bare repository root, also send the approved implementation task without
   waiting to be asked.
