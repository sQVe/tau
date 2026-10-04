---
name: worktree
description:
  Create or open a Git worktree for a ticket or task with Grove and open it in Herdr. Use it when
  asked to create, add, start, or open a worktree, optionally followed by a handoff.
metadata:
  required-for: creating a Git worktree, including as a step in a larger task
---

# Worktree

## When to use

Use this skill when the user asks for a worktree for a ticket or a piece of work. When you work from
the bare repository root, an approved implementation task is such a request: create the worktree and
tell the user. Otherwise, agreeing to a change is not a request for a worktree. Grove creates the
worktree and runs the repository's add hooks, such as dependency installs.

## Hard rules

- For an implementation handoff, check before `grove add` that the work is ready, as the
  [handoff skill](../handoff/SKILL.md) defines it. Create no worktree while anything is open, unless
  the user says to plan in it.
- Creating a worktree does not start work. Do not change the ticket's status unless the user asks.
  Do not start the work in the new worktree yourself. It belongs to the agent in that workspace.
- Report a failed `grove add` before retrying or handing off. Do not work around it with
  `grove switch`, `--no-fetch`, or `--no-hooks`.

## Procedure

1. Choose the branch, in this order:
   - The branch the user names.
   - For a ticket, its Linear branch name from `linear issue view <ID> --json --no-pager`. Pass
     `--workspace <slug>` when the ticket lives outside the default workspace.
   - If Linear has none, or there is no ticket, a descriptive kebab-case name from the ticket ID and
     title, or from the task.
2. Run `grove add <branch> --name <lowercase-ticket-id> --herdr` from the repository.
   - Omit `--name` without a ticket.
   - Pass `--base <base>` only for a new branch whose base the user or project names. Otherwise
     Grove uses the default branch. Grove rejects `--base` for an existing branch.
   - If the branch already has a worktree, Grove opens it instead.
3. If the user asked for a handoff, send it to the new workspace with the
   [handoff skill](../handoff/SKILL.md).
