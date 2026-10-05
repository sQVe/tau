---
name: tracker
description:
  Write Linear tickets by Tau's rules. Picks the ticket type and its template, routes it to the
  right team and project, searches for an open duplicate, and runs the `linear` commands for tickets
  and the one allowed status change. Use it for "file a bug", "create a ticket", "write this up in
  Linear", or "add a follow-up ticket". It does not split a design into slices or start a slice.
metadata:
  required-for:
    creating or updating a Linear ticket, its relations, or its status, including as a step in a
    larger task
---

# Tracker

## When to use

Use this skill for every Linear write: a new ticket, an edit, a relation, or a status change. Other
skills follow it at the step that writes to Linear, and their preview counts as this skill's
preview. It needs the `linear` CLI authenticated for the workspace.

## Hard rules

- Write to Linear only after the user approves a preview that shows the write. Any change after
  approval needs a new preview.
- Ask every question with the `ask_user_question` tool. Never end a turn with a question in prose.
- Make one status change only: move a slice to In Progress when it starts. Linear's GitHub
  integration moves a ticket to Done once the PR that fixes it merges. Never close, cancel, reopen,
  or move a ticket to any other status.
- Take teams and projects only from the tracker lines in the prompt. Never guess a team, a project,
  or a label.

## Procedure

1. Pick the ticket type and its template. Every template ends with `## Acceptance` and checkboxes.
   The [slice skill](../slice/SKILL.md) writes containers and slices.
   - Human ticket: work for a person that is not a design, a slice, or a bug. Use the
     [human ticket template](templates/human-ticket.md).
   - Container: a human ticket that holds an agreed design and has slices as children. Use the
     [container template](templates/container.md).
   - Slice: a human sub-ticket of a container that one branch and one PR deliver. Use the
     [slice template](templates/slice.md).
   - Agent ticket: a sub-ticket of a slice that one worker carries out. Use the
     [agent ticket template](templates/agent-ticket.md).
   - Bug: a defect a person should see. Use the [bug template](templates/bug.md).

2. Route the ticket from the tracker lines Tau adds to the prompt.
   - Every ticket needs the line that starts with `Tracker repository:`, agent tickets included,
     because it ties the work to this repository. A container, slice, bug, or human ticket goes to
     the team and project in that line. Without a project there, create it without one.
   - An agent ticket goes to the team in the line that starts with `Tracker agent team:`, with no
     project.
   - A ticket with a parent, other than an agent ticket, still takes the `Tracker repository:`
     route. An example is a slice under its container. Read the parent's team and project with
     `linear api 'query($id: String!) { issue(id: $id) { team { key } project { name } state { name } } }' --variable id=<parent>`.
     If either differs from the route, stop. Tell the user that the parent is in team
     `<parent team>` and project `<parent project>`, but this repository routes to team
     `<route team>` and project `<route project>`.
   - If a line the ticket needs is missing, stop. Show each line that starts with
     `Tracker setup needed:`, and tell the user to add the missing part to `~/.pi/agent/tau.json`,
     then run `/reload` or start a new session. The repository key is the `origin` remote's
     `owner/name`, and `project` is optional:

     ```json
     {
       "tracker": {
         "agentTeam": "AI",
         "repositories": { "<owner>/<name>": { "team": "<team key>", "project": "<project name>" } }
       }
     }
     ```

3. Search for an open duplicate before you write a new ticket. Search the target team, and its
   project when it has one, with a few keywords from the title. Leave out `--project` for an agent
   ticket:

   ```sh
   linear issue query --search '<keywords>' --team <team> --project '<project>' --state triage --state backlog --state unstarted --state started --json --no-pager
   ```

   A search without `--project` also returns tickets in other projects. Before you offer a match,
   read its team, project, and parent with
   `linear api 'query($id: String!) { issue(id: $id) { team { key } project { name } parent { identifier } } }' --variable id=<match>`.
   A match fits when all three equal the planned ticket's. Show each match that fits, and ask: use
   or update the match, or create the new ticket anyway. Show a match that does not fit only with
   what differs, and never offer to reuse it. A retry that finds a fitting ticket it created earlier
   uses that ticket without asking.

4. Write the title and body.
   - Write the title as an imperative in sentence case, about 70 characters at most, with no prefix.
     Start a bug title with `Fix <symptom>`.
   - Fill the template. Leave out a section that has nothing to say, but keep `## Acceptance`.
   - Look up labels with `linear label list --team <team> --json` once per team in the session. Add
     a label only when the list has one that fits, such as `Bug` for a bug, and spell it as the list
     does. Keep each label's `id` too, since an agent ticket takes labels by ID. Never create a
     label.
   - Save the body in the calling skill's draft directory, or in a file from `mktemp`.

5. Preview the writes, unless the calling skill's preview already shows them: each ticket with its
   type, title, team, project, labels, and parent, and each relation and status change. Approve with
   `ask_user_question`.

6. Write with these commands, in the previewed order. Write each `'` in every single-quoted value,
   such as a title, search term, project, or label, as `'\''`, so the shell expands nothing in it.
   After each create, note the identifier the output shows. If it shows none, stop and search the
   parent's children or the team before any retry.
   - Make every write to a container and its slices with the `slice` tool, through the
     [slice skill](../slice/SKILL.md): creating them, editing them, their `blocked-by` relations,
     and their order.
   - Create a bug or human ticket. Leave out `--project` when the route has none. Add
     `--parent <parent>` when the approved ticket has a parent, and `--label '<label>'` for each
     label:
     `linear issue create --team <team> --project '<project>' --title '<title>' --description-file <file> --no-interactive`.
   - Create an agent ticket through the API. `linear issue create --parent` copies the parent's
     project, which fails when the agent team is not in that project. Read the agent team's ID with
     `linear api 'query($key: String!) { team(id: $key) { id } }' --variable key=<agent team>`,
     then:

     ```sh
     linear api 'mutation($team: String!, $parent: String!, $title: String!, $description: String!, $labels: [String!]) { issueCreate(input: { teamId: $team, parentId: $parent, title: $title, description: $description, labelIds: $labels }) { issue { identifier url } } }' --variable team=<team id> --variable parent=<slice> --variable 'title=<title>' --variable description=@<file> --variables-json '{"labels": ["<label id>"]}'
     ```

     Pass the IDs of the approved labels from the agent team's label list, or `[]` when there are
     none.

   - Update a ticket's title or body. Leave out the flag for the part that stays:
     `linear issue update <ticket> --title '<title>' --description-file <file>`.
   - Move a slice to In Progress when it starts. Read its state name with the step 2 query, run on
     the slice. If the name is `In Progress`, skip the move; any other state, `In Review` included,
     moves. Move it with `linear issue update <slice> --state 'In Progress'`. If the team has no
     state with that name, stop and ask the user.

7. Link the ticket from the PR. Write `Fixes <id>` in the PR body only for the ticket the PR
   completes, such as the slice, and `Related to <id>` for every other ticket it touches. Never list
   an agent ticket or a container as fixed.

8. Report each ticket with its identifier and URL, and each relation and status change made.
