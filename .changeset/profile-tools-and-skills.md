---
'tau': minor
---

Give each worker only the tools and skills its profile names. A profile's `tools:` setting lists its
tools; without it, investigation profiles get `read` and `bash`, and editing profiles add `edit` and
`write`. The three `subagent_*` report tools are always added. Workers launch with Pi's `--tools`
allowlist, so no extension can activate another tool later, and with `--no-skills`. A profile's
`skills:` setting names the skills to load. A worker refuses to start when a listed tool is not
registered, and launch fails when a listed skill is not found.

The bundled profiles name the tools their workers used. `scout` keeps the web tools and `bulk_read`,
`worker` keeps `run_tests` and `commit`, and `qa` keeps `agent_browser` and `agent_browser_code`.
The fixed prompt of a bundled worker's first request drops from 66k characters to 24k–34k.

Task records move to format 4, which saves the tools and skills. Follow-ups of older tasks get their
role's default tools and no skills.
