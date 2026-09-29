# ADR 0067: Give workers only their profile's tools and skills

- Status: Accepted
- Date: 2026-09-29

## Context

- A worker loads the parent's whole Pi configuration, so it kept every extension tool and listed
  every skill. The tool schemas and the skill list are sent again on every turn.
- In one measured bundled worker, tools and the skill list took over half of a 66k-character first
  request.
- Saved worker sessions show that workers use few of those tools and skills. Only scouts used the
  web tools often.
- Every extension must still load. The worker refuses to start without CC Safety Net from Tau's
  bundled file, [ADR 0028](./0028-keep-worker-control-in-the-parent.md) rejects restricted extension
  loadouts, and reloading extensions once left the Claude bridge provider unregistered.
- Activating tools after startup does not hold. Some extensions, such as the questionnaire, activate
  their tool again before every prompt.

## Options considered

- Keep every tool and skill. Rejected: this costs about 9k tokens per worker turn for tools and
  skills that workers do not use.
- Restrict which extensions load, as Pi Herdsman does with `noExtensions`. Rejected: every extension
  must still load, as Context explains.
- Set the active tools after startup only. Rejected: any extension can activate its tool again, as
  the questionnaire does.
- Launch the worker with Pi's `--tools` allowlist and `--no-skills`, and check the allowlist after
  the Safety Net check. Chosen: every extension still loads, but Pi registers only the listed tools.

## Decision

Each worker gets only the tools and skills its profile names.

### Tools

- A profile's `tools:` setting is the full tool allowlist. Without it, investigation profiles get
  `read` and `bash`, and editing profiles get `read`, `bash`, `edit`, and `write`.
- `subagent_progress`, `subagent_report`, and `subagent_question` are always added. A profile cannot
  remove them.
- The worker launches with `--tools`, so Pi registers no other tool and no extension can activate
  one later.
- After the Safety Net check, the worker refuses to start if a listed tool is not registered, and it
  names the tool. It does not skip the tool. CC Safety Net acts through hooks, not a tool, so no
  allowlist can remove it.

### Skills

- Workers launch with `--no-skills`. A profile's `skills:` setting names the skills to load.
- The parent looks up each skill by name among its own skills at launch and saves the path. Launch
  fails if a named skill is not found.

### Bundled profiles

The bundled profiles name the tools their workers used in saved sessions:

- `worker`: the editing defaults, `run_tests`, and `commit`. Workers use `run_tests` for tests, and
  some tasks ask them to commit.
- `scout`: the investigation defaults, `write`, `bulk_read`, and the web tools `web_search`,
  `fetch_content`, and `get_search_content`. Scouts research outside the repository.
- `reviewer`: the investigation defaults and `write`. It loads no skill, because the manager copies
  the reviewer rules from `code-review` into each assignment.
- `qa`: the investigation defaults, `write`, `agent_browser`, and `agent_browser_code`. The browser
  tools come from `pi-agent-browser-native`, which Tau does not bundle. The `qa` profile loads that
  package itself ([ADR 0069](./0069-load-each-pi-package-where-its-tools-are-used.md)).

The investigation profiles get `write` because their instructions save long details to a file.

### Saved tasks

Task record format 4 saves the tool allowlist and the skill paths in the loadout. A follow-up of a
task saved in format 1 or 3 gets its role's default tools and no skills.

## Tradeoffs

- The measured fixed prompt of a bundled worker drops from 66k characters to 24k to 34k.
- A tool that disappears from the configuration stops the worker at startup with its name.
- Cost: a worker that needs another tool or skill needs a profile that lists it.
- Cost: `agent_browser_tools` cannot enable advanced browser tools unless the profile lists them.
- Cost: a skill path saved at launch must still exist when the task is followed up.

## See also

- [ADR 0028: Keep worker control in the parent](./0028-keep-worker-control-in-the-parent.md)
- [ADR 0053: Version each saved record format](./0053-version-each-saved-record-format.md)
- [ADR 0058: Run subagents only as Pi workers](./0058-run-subagents-only-as-pi-workers.md)
- [ADR 0069: Load each Pi package where its tools are used](./0069-load-each-pi-package-where-its-tools-are-used.md)
