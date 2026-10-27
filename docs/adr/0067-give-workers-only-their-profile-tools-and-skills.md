# ADR 0067: Give each worker profile one loadout of tools, skills, instruction sets, and packages

**Date**: 2026-09-29\
**Status**: Accepted\
**Supersedes**: [ADR 0068 (Load only the instruction sets each worker profile needs)](./README.md#retired),
[ADR 0069 (Load each Pi package where its tools are used)](./README.md#retired),
[ADR 0084 (Keep the diagram skill out of worker profiles)](./README.md#retired)\
**Related**: [ADR 0006 (Load Tau's instruction sets into every prompt)](./0006-default-writing-policy.md),
[ADR 0043 (Run subagents as Pi workers with a thin task layer over herdr)](./0043-own-only-the-worker-guarantees-herdr-lacks.md),
[ADR 0053 (Version each saved record format)](./0053-version-each-saved-record-format.md),
[ADR 0076 (Give browser workers one shared set of browser rules)](./0076-give-browser-workers-one-shared-set-of-browser-rules.md),
[ADR 0087 (Gather evidence with codemode)](./0087-gather-evidence-with-codemode.md),
[ADR 0099 (Warn on unknown config keys and fail only the entry in use)](./0099-warn-on-unknown-config-keys-and-fail-only-the-entry-in-use.md)

## Context

A worker loads the parent's whole Pi configuration, so it kept every extension tool and listed every
skill. It also got every instruction set and every package. The tool schemas, the skill list, and
the instructions are sent again on every turn. In one measured bundled worker, tools and the skill
list took over half of a 66k-character first request. Saved worker sessions show that workers use
few of those tools and skills. Only scouts used the web tools often.

Every extension must still load. The worker refuses to start without CC Safety Net from Tau's
bundled file, [ADR 0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md) rejects restricted
extension loadouts, and reloading extensions once left the Claude bridge provider unregistered.

Activating tools after startup does not hold. Some extensions, such as the questionnaire, activate
their tool again before every prompt.

## Decision

Each worker profile names one loadout: its tools, skills, instruction sets, and packages. A worker
launches with only that loadout. Every extension still loads, but Pi registers only the listed
tools, and the worker reads only the listed skills.

### Tools

- A profile's `tools:` setting replaces the defaults for its role. Without it, investigation
  profiles get `read` and `bash`, and editing profiles get `read`, `bash`, `edit`, and `write`.
- Tau always adds `subagent_progress`, `subagent_report`, and `subagent_question`. A profile cannot
  remove them.
- A loaded skill adds the tools it needs. The skill tool table in `src/skillTools.ts` names them,
  such as `mutation_check` for `tdd`.
- Tau removes `full_check` from every worker, even when a worker loads the `pr` skill. Only the
  manager's PR step runs the full check.
- The launch passes the list as Pi's `--tools` allowlist. Pi then registers no other tool, and no
  extension can activate one later.
- After the CC Safety Net check, the worker refuses to start if a listed tool is not registered. It
  names the missing tool and does not skip it. CC Safety Net acts through hooks, not a tool, so no
  allowlist can remove it.

### Skills

- Workers launch with `--no-skills`. A profile's `skills:` setting names the skills to load, and the
  launch passes each skill path with `--skill`.
- The launch finds each named skill among the parent's skills and saves its path. Launch fails when
  a named skill is not found.

### Instruction sets

- `instruction-sets:` names the sets to load, from `writing`, `coding`, `workflow`, and `browser`,
  separated by commas. An unknown or empty name makes the profile invalid.
- Without the setting, a profile gets `writing`, `coding`, and `workflow`. The `browser` set is
  opt-in. User and project profiles keep the same default.
- The launch saves the sets in the loadout. In a worker process, the writing, coding, and workflow
  extensions do not append their text. The worker appends its saved sets after its own instructions,
  in the order writing, coding, workflow, browser. The order in the setting does not change it.
- The browser set's rules are in
  [ADR 0076](./0076-give-browser-workers-one-shared-set-of-browser-rules.md).

### Packages

- A profile's `packages:` setting lists Pi package sources, written as `pi -e` accepts them.
- Load each package where its tools are used:
  - Bundle a package in `package.json` when Tau checks, adjusts, or requires it. Tau bundles
    `cc-safety-net` and `pi-web-access`.
  - Keep a package in the user's settings when the parent uses its tools itself.
  - Name a package in a profile when only that profile's workers use its tools. The parent does not
    load it.
- Before it opens the worker's pane, the parent installs each profile package. An install failure,
  or a package without Pi resources, stops the launch and names the package.
- A package that the user's or project's settings already load gets no `-e`. Loading it twice would
  leave the tool conflict to Pi's load order.
- The worker loads each remaining package with `-e`, after Tau's worker extensions. It still loads
  every extension the parent loads, so a package never removes CC Safety Net or a model provider.
- Trim the parent's prompt with evidence:
  - Count parent tool calls and skill reads from saved sessions before cutting a package.
  - Move a package the parent rarely uses to a profile that does that work, or filter it out in the
    user's settings.
  - When the cost sits in a package's own prompt text, file an issue with that package.

### Bundled profiles

| Profile    | Tools                                                                                    | Skills | Instruction sets                 | Packages                      |
| ---------- | ---------------------------------------------------------------------------------------- | ------ | -------------------------------- | ----------------------------- |
| `worker`   | `read`, `bash`, `edit`, `write`, `codemode`, `run_tests`, `commit`                       | `tdd`  | default                          | none                          |
| `scout`    | `read`, `bash`, `write`, `codemode`, `web_search`, `fetch_content`, `get_search_content` | none   | `writing`, `workflow`            | none                          |
| `reviewer` | `read`, `bash`, `write`, `codemode`                                                      | none   | default                          | none                          |
| `checker`  | `read`, `bash`, `write`, `codemode`                                                      | none   | default                          | none                          |
| `browser`  | `read`, `bash`, `write`, `agent_browser`, `agent_browser_code`                           | none   | `writing`, `workflow`, `browser` | `npm:pi-agent-browser-native` |
| `qa`       | `read`, `bash`, `write`, `agent_browser`, `agent_browser_code`                           | none   | `writing`, `workflow`, `browser` | `npm:pi-agent-browser-native` |

- `scout`, `reviewer`, `checker`, and `worker` list `codemode` by name. `browser` and `qa` do not.
  They act in a browser and do not gather repository evidence in bulk.
- `bulk_read` is removed. A custom profile that still names it fails at startup. Tau does not
  substitute another tool.
- Workers report structure as prose with file and line evidence. The manager draws any diagram from
  that evidence in its own reply, where Pi and GitHub render Mermaid.
- Worker profiles do not load the `diagram` skill, custom profiles included. This is a rule for
  profile authors, and no runtime check enforces it. No bundled profile loads it.

### Saved tasks

- The launch saves the tools, skill paths, instruction sets, and packages in the task loadout.
- A follow-up uses its saved loadout, not the current profile file. It keeps the tools, skills,
  sets, and packages of its original launch.

### Model routes

A profile may route its brief to a classifier. The classifier is a model that picks one of two
labels. Each label names the model for that launch.

A narrow lookup and a wide investigation often need different models. One profile can get both kinds
of brief, and one model for every launch fits only one of them. The classifier reads the brief and
then chooses, so the launch can use the model that fits.

Route config belongs only in the user file, under `profiles.<name>.route`. It is not a profile
frontmatter setting. The route names:

- `classifier`: the model that picks the label.
- `question`: the question the classifier answers.
- `labels`: exactly two names, each with a `criterion` and a `model`.
- `confidence`: optional. It defaults to 0.7.

The profile's `model` stays the fallback. Routing works like this:

- The classifier must pass `allowedModels`, because the brief leaves the machine. A classifier that
  `allowedModels` excludes skips routing.
- The classifier sees the brief and the profile. It may also see a bounded part of the ticket.
- Tau stops waiting for the classifier after five seconds.
- A pick at or above the confidence cutoff launches on that label's model.
- Low confidence, an unknown label, an error, a timeout, or a skipped classifier keeps the profile's
  `model`.
- An explicit launch model skips routing.
- The routed model passes the normal launch checks. An invalid routed model is not replaced.
- A bad `route` turns off routing for that profile only. Its `model` still applies.

## Consequences

### Positive

- A bundled worker's fixed prompt is about half the size it had when workers loaded the parent's
  whole loadout, so every worker request costs fewer tokens.
- Scouts and QA workers no longer receive the coding instructions on each turn.
- A tool that disappears from the configuration stops the worker at startup, and the error names it.
- A new profile adds no package tools or skills to the parent's prompt. It still adds its name and
  description to the `subagent` tool.
- The user keeps control of the packages the parent loads, and Tau works without them.

### Negative

- A worker that needs another tool or skill needs a profile that lists it.
- A profile for a role that does not write code must set `instruction-sets:` to save the coding
  text.
- A profile gets every skill of the packages it names. Its tool allowlist narrows the tools, but not
  the skills.
- The parent cannot call a profile's tools directly. It must start a worker for that work.
- A worker launch fails when a named package cannot be installed or loaded, or a named skill is not
  found.
- A skill path saved at launch must still exist when the task is followed up.
- An instruction set added later needs a new name in the setting and in the list of allowed names.
- Pi keeps an unpinned npm package at the version it first cached. Pin a version to update it.

## Alternatives considered

### Keep every tool and skill

Keep every tool and skill. Rejected because this costs about 9k tokens per worker turn for tools and
skills that workers do not use.

### Restrict which extensions load

Restrict which extensions load, as Pi Herdsman does with `noExtensions`. Rejected because every
extension must still load, as Context explains.

### Set active tools after startup only

Set the active tools after startup only. Rejected because any extension can activate its tool again,
as the questionnaire does.

### Every instruction set for every worker

Keep every set for every worker. Rejected because this costs about 4.4k characters per turn for
scouts and QA.

### Instruction sets by role

Choose the sets by role, so investigation profiles drop the coding set. Rejected because the
reviewer is an investigation profile but needs the coding set.

### Instruction sets in an environment variable

Send the list of sets to the worker through an environment variable. Rejected because the worker
reads its saved task, so a follow-up would lose a list that only the launch environment carried.

### Load every package in the parent

Keep loading every package in the parent's settings, and narrow workers with profile allowlists.
Rejected because the parent pays for every profile's tools, used or not.

### Deactivate unused tools in the parent

Deactivate unused tools in the parent with `setActiveTools`. Rejected because an extension can
activate its tool again, as the questionnaire does, and the parent still lists the package's skills.

### Filter the package out of the user's settings

Filter a rarely used package out of the user's settings. Rejected because, although the parent stops
paying, no profile can use the package either.

### Diagram skill in every worker profile

Load the `diagram` skill in every worker profile. Rejected because worker reports would carry
Mermaid source that nobody sees rendered, and each worker would load a skill it cannot use well.

### Always one model

Use one model for every launch of a profile. Rejected because it loses the difference between narrow
and wide briefs, as the Model routes section explains.

### Tau never routes

Never route a brief, and make the user choose a model for each launch. Rejected because every launch
would then need a manual model choice to gain the difference between briefs.
