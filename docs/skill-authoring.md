# Skill authoring

Use this guide when you write or change a skill in `src/skills/` or a Tau tool that a skill calls.
For a skill, copy the [template](./skill-template.md) to `src/skills/<name>/SKILL.md` and fill it
in. Then go through the checklist. `tests/skillFiles.test.ts` checks every skill's frontmatter,
local links, headings, ADR mentions, and shell blocks.

## Shape

- Set `name` to the directory name. Write a description that says what the skill does and lists the
  phrases a user would say to start it.
- Decide on `metadata.required-for` for every skill. Add it when the agent might take the skill's
  action as a step in its own plan, such as a push, a pull request, or a Linear write. The value
  completes "Use the `<name>` skill whenever you are ...".
- Use only the sections the skill needs: `When to use`, `Goal`, `Hard rules`, `Procedure`, and
  `Checklist`. A few existing skills have extra sections, which the test lists by name until they
  move out.
- State each rule in the skill in your own words. Never link to, name, or cite an ADR.
- Link a tool, template, or file at the step that uses it. Do not add a `## See also` section.

## Put each instruction in one place

| Instruction                                                    | Where it goes                                 |
| -------------------------------------------------------------- | --------------------------------------------- |
| Judgment, order of steps, approvals, and boundaries            | The skill                                     |
| Command mechanics, JSON fields, parsing, and retry handling    | A tested tool, named at the step it serves    |
| When to call each action, and what the inputs and results mean | The tool description                          |
| Why a call failed                                              | The error text                                |
| The shape of a body or preview the user sees                   | A template file next to the skill             |
| A rule for all work, not one workflow                          | The coding, writing, or workflow instructions |

Split reading from writing in a tool. A read returns the current state and the exact writes it
plans. An apply takes that plan and refuses when the state has changed since the read.

## Place the tool

- Put the tool in its own extension under `src/extensions/<feature>/`, and call the extension from
  `src/tau.ts`.
- Register a skill tool as a normal direct tool, active on registration. Add the skill name and tool
  name to `src/skillTools.ts`. Managers get every skill tool from session start. Workers get the
  tools for their loaded skills through the same map.
- When two skills need the same mechanics, share one tool or module. Never copy the mechanics into
  another tool or skill. Create a scratch directory inside an ignored `.tau/` with
  `src/tauDirectory.ts`.

## Write the description

The description tells the model when to call each action, its inputs, the result fields a caller
acts on, and the meaning of any field that is easy to misread. Leave out how the tool works, the
commands it runs, and lists of errors. Errors name their own cause. Tests are the behavior spec.

- A one-action tool has a budget of 1,000 characters. A multi-action tool has a budget of 3,000
  characters. A tool is multi-action when its schema has an `action` parameter.
- The budget counts the description only. Schemas are excluded.
- Raise a budget only by editing it here, with the reason beside it.

## Keep scripts out of skills

Shell in a skill has no tests, and every copy drifts on its own.

- A step may give one command with its arguments, such as a `gh` or `linear` call.
- Move a shell block with several commands, conditions, or safety checks into a tested Tau tool. The
  step names the tool and says what to do with its result. Write the tool as
  [Place the tool](#place-the-tool) and [Write the description](#write-the-description) say.
- The test rejects a new shell block with more than one command and lists the existing ones until a
  tool replaces them.
- A step may gather evidence with one read-only `codemode` script that composes tested readers, such
  as Tau tools. Target resolution, approvals, writes, and review judgment stay outside the script.

## Delete before you add

Skills grow when every review finding becomes a new paragraph. Before you add text:

- Look for text the new rule replaces, and change the step that caused the problem.
- Show decisions and their effects in a preview, not raw commands.
- Do not repeat the procedure in the checklist.

## Checklist

Inputs:

- [ ] Every input the description accepts, such as an argument, a file, or a ticket, supplies each
      value the later steps use. Trace each command argument back to its source.
- [ ] Each guard reads the field it checks.
- [ ] Missing, ambiguous, and nothing-to-do cases each have a step: ask, stop, or report.

Writes:

- [ ] Each write follows the tracker skill's [Hard rules](../src/skills/tracker/SKILL.md#hard-rules)
      list, which says which writes need an approved preview. A write is a push, a pull request, a
      ticket, a comment, or a shared file. Link to the list instead of restating it.
- [ ] Nothing changes between the preview and the write. If it does, preview again.
- [ ] Each hard rule holds on every path, including the retry and continue paths.
- [ ] Scratch files use a task-named path or `mktemp`, never a shared name in `/tmp`.
- [ ] A tool asks with `confirmWithUser` in `src/confirm.ts` before a write outside the worktree
      that the tracker skill's [Hard rules](../src/skills/tracker/SKILL.md#hard-rules) list says
      needs approval. That confirm is the approval the list asks for, so the calling skill does not
      ask again. It refuses in a worker, even one with UI, because the user does not watch the
      worker's pane.
- [ ] The confirm shows the exact writes the tool will make, so the user sees what they approve.
- [ ] When a call has a write that needs a confirm, the tool writes nothing if the user declines or
      the session is a worker or has no UI.

Interrupted and retried runs:

- [ ] Checks run after the last change to what they cover. The skill saves real command output,
      never a summary.
- [ ] The last approved plan stays until the user approves the new one.
- [ ] Saved IDs survive a retry, a rename, or a retitle, so a rerun updates instead of duplicating.
      A retry applies only the writes that are missing.
- [ ] A partial failure stops and reports what was applied and what was not.

Commands:

- [ ] Each command, flag, and JSON field matches the installed CLI's `--help` or source. When help
      does not settle what a command does, run it in a temporary repository.
- [ ] Each command runs without a prompt.
- [ ] Steps respect tool limits, such as four questions per `ask_user_question` call.

Tools:

- [ ] A tool parses command output once, at the boundary, and fails with an error that names the bad
      output.
- [ ] Tool tests use a fake CLI for normal, missing, and malformed output.
- [ ] Tool tests cover a declined confirmation, a worker, a session without UI, and a retry after a
      partial failure.
- [ ] The description fits its budget.

Length:

- [ ] Each paragraph helps the model decide or act. Tool internals and repeated checks are gone.
