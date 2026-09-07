---
name: bro
description:
  Restate the previous message in plain language, covering what happened, what it means, and what to
  do next. Use it when the user asks to explain that, say it in plain English, or eli5. Not for
  redoing the work.
---

# Bro

## When to use

Use this skill when the previous message did not land and the user asks for it again in plain
language.

## Goal

Say the previous message again, plainly. The user already got the answer once, so the job is
translation, not new work.

## Hard rules

- Write a few sentences: what happened, what it means, what to do next.
- Name real files, commands, and numbers instead of categories.
- Do not use jargon, tables, or raw tool output.
- Explain, do not re-run. Beyond loading this skill, make no tool calls, start no new investigation,
  and give no revised answer. If the previous message was wrong, fixing it is a new request.
- Report the same outcome the previous message reported. A failure stays a failure. Do not soften it
  into "mostly working" and do not turn a warning into a crisis.
- If the previous message asked a question or laid out a decision, restate the choice and what each
  option costs. Do not pick one. The decision is still the user's.

## See also

- `docs/adr/0004-skill-authoring-style.md`
