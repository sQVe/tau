---
name: tracker
description:
  Write Linear tickets by Tau's rules. Picks the ticket type and its template, routes it to the
  right team and project, searches for an open duplicate, and runs the `linear` commands for tickets
  and the two allowed status changes. Use it for "file a bug", "create a ticket", "write this up in
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
- Make only two status changes: move a slice to In Progress when it starts, and cancel a ticket
  after the user approves a preview that shows the cancellation, such as a duplicate or a slice
  dropped from a plan. Linear's GitHub integration moves a ticket to Done once the PR that fixes it
  merges. Never close, reopen, or move a ticket to any other status.
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
     route. An example is a slice under its container.
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

3. Gather the evidence for every planned ticket before you write it. Run one read-only `codemode`
   script that calls the `tracker_evidence` tool once per planned ticket, with its route and parent
   from step 2 and a few keywords from its title. Return the results unchanged. Then, for each
   ticket:
   - If the result says the parent does not match the route, stop. An agent ticket's parent is not
     compared. Tell the user that the parent is in team `<parent team>` and project
     `<parent project>`, but this repository routes to team `<route team>` and project
     `<route project>`.
   - Show each candidate that fits, and ask: use or update the candidate, or create the new ticket
     anyway. Show a candidate that does not fit only with what differs, and never offer to reuse it.
     A retry that finds a fitting ticket it created earlier uses that ticket without asking.
   - If the search left a gap, show the gap in the preview and ask whether to search again or create
     the ticket anyway. Never call it "no duplicate".
   - If the parent read left a gap, stop and report the gap. Never guess a parent's route.
   - If the label read left a gap, create the ticket without labels and show the label gap in the
     preview. Never guess a label.

4. Write the title and body.
   - Write the title as an imperative in sentence case, about 70 characters at most, with no prefix.
     Start a bug title with `Fix <symptom>`.
   - Fill the template. Leave out a section that has nothing to say, but keep `## Acceptance`.
   - Add a label only when the ticket's labels from step 3 have one that fits, such as `Bug` for a
     bug, and spell it as the list does. Keep each label's `id` too, since an agent ticket takes
     labels by ID. Never create a label. Containers and slices take no labels, since the `slice`
     tool creates them without any.
   - Save the body in the calling skill's draft directory, or in a file from `mktemp`.

5. Preview the writes, unless the calling skill's preview already shows them: each ticket with its
   type, title, team, project, labels, and parent, and each relation and status change. Approve with
   `ask_user_question`.

6. Write with these commands, in the previewed order. Write each `'` in every single-quoted value,
   such as a title, search term, project, or label, as `'\''`, so the shell expands nothing in it.
   After each create, note the identifier the output shows. If it shows none, stop and search the
   parent's children or the team before any retry.
   - Create containers and slices, edit their titles and bodies, and write the `blocked-by`
     relations between slices and their order with the `slice` tool, through the
     [slice skill](../slice/SKILL.md). Move a slice to In Progress with the command below.
   - Create a bug or human ticket. Leave out `--project` when the route has none. Add
     `--parent <parent>` when the approved ticket has a parent, and `--label '<label>'` for each
     label:
     `linear issue create --team <team> --project '<project>' --title '<title>' --description-file <file> --no-interactive`.
   - Create an agent ticket through the API. `linear issue create --parent` copies the parent's
     project, which fails when the agent team is not in that project. Read the agent team's ID with
     `linear api 'query($key: String!) { team(id: $key) { id } }' --variable key=<agent team>`,
     then:

     ```sh
     linear api 'mutation($team: String!, $parent: String!, $title: String!, $description: String!, $labels: [String!]) { issueCreate(input: { teamId: $team, parentId: $parent, title: $title, description: $description, labelIds: $labels }) { issue { identifier url } } }' --variable team=<team id> --variable parent=<slice> --variable description=@<file> --variables-json '{"title": "<title>", "labels": ["<label id>"]}'
     ```

     Write the title as a JSON string, escaping `"` and `\`. Pass the IDs of the approved labels
     from the agent team's label list, or `[]` when there are none.

   - Update the title or body of a bug, human ticket, or agent ticket. Leave out the flag for the
     part that stays: `linear issue update <ticket> --title '<title>' --description-file <file>`.
   - Add a dependency that the `slice` tool does not write, such as one on a ticket outside the
     container: `linear issue relation add <ticket> blocked-by <other>`. Remove one with
     `linear issue relation delete <ticket> blocked-by <other>`.
   - Move a slice to In Progress when it starts. Read its state name with
     `linear api 'query($id: String!) { issue(id: $id) { state { name } } }' --variable id=<slice>`.
     If the name is `In Progress`, skip the move; any other state, `In Review` included, moves. Move
     it with `linear issue update <slice> --state 'In Progress'`. If the team has no state with that
     name, stop and ask the user.
   - Cancel an approved ticket. Read its state and links with
     `linear api 'query($id: String!) { issue(id: $id) { state { type } attachments { nodes { url } } } }' --variable id=<ticket>`.
     Skip it if its state type is `canceled`. Stop and ask the user if the type is `completed`, or
     if `gh pr view <url> --json state` returns `MERGED` for a linked pull request. If any of these
     reads fails, stop and report it. Otherwise cancel it with
     `linear issue update <ticket> --state canceled --no-input`. If the command fails, stop and
     report the error.

7. Link the ticket from the PR. Write `Fixes <id>` in the PR body only for the ticket the PR
   completes, such as the slice, and `Related to <id>` for every other ticket it touches. Never list
   an agent ticket or a container as fixed.

8. Report each ticket with its identifier and URL, and each relation and status change made.
