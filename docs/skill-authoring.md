# Skill authoring

Use this guide when you write or change a skill in `src/skills/`. Copy the
[template](./skill-template.md) to `src/skills/<name>/SKILL.md` and fill it in. Then go through the
checklist. `tests/skillFiles.test.ts` checks every skill's frontmatter, local links, headings, ADR
mentions, and shell blocks.

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

| Instruction                                                 | Where it goes                                 |
| ----------------------------------------------------------- | --------------------------------------------- |
| Judgment, order of steps, approvals, and boundaries         | The skill                                     |
| Command mechanics, JSON fields, parsing, and retry handling | A tested tool, named at the step it serves    |
| The shape of a body or preview the user sees                | A template file next to the skill             |
| A rule for all work, not one workflow                       | The coding, writing, or workflow instructions |

## Keep scripts out of skills

Shell in a skill has no tests, and every copy drifts on its own.

- A step may give one command with its arguments, such as a `gh` or `linear` call.
- Move a shell block with several commands, conditions, or safety checks into a tested Tau tool. The
  step names the tool and says what to do with its result. Write the tool with the
  [tool authoring guide](./tool-authoring.md).
- The test rejects a new shell block with more than one command and lists the existing ones until a
  tool replaces them.

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

- [ ] Each write comes after the user approves a preview that shows it. A write is a push, a pull
      request, a ticket, a comment, or a shared file. A reply to a GitHub bot posts without
      approval, but a write that answers a person still needs it.
- [ ] Nothing changes between the preview and the write. If it does, preview again.
- [ ] Each hard rule holds on every path, including the retry and continue paths.
- [ ] Scratch files use a task-named path or `mktemp`, never a shared name in `/tmp`.

Interrupted and retried runs:

- [ ] Checks run after the last change to what they cover. The skill saves real command output,
      never a summary.
- [ ] The last approved plan stays until the user approves the new one.
- [ ] Saved IDs survive a retry, a rename, or a retitle, so a rerun updates instead of duplicating.
- [ ] A partial failure stops and reports what changed and what did not.

Commands:

- [ ] Each command, flag, and JSON field matches the installed CLI's `--help` or source. When help
      does not settle what a command does, run it in a temporary repository.
- [ ] Each command runs without a prompt.
- [ ] Steps respect tool limits, such as four questions per `ask_user_question` call.

Length:

- [ ] Each paragraph helps the model decide or act. Tool internals and repeated checks are gone.
