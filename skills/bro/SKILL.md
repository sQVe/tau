---
name: bro
description:
  Restate the last assistant response in plain language, covering what happened, what it means, and
  what to do next. Use it when the user asks to explain that, say it in plain English, or eli5. Not
  for redoing the work.
---

# Bro

## When to use

Use this skill when the user did not understand the last assistant response and asks for it in plain
language.

## Goal

Restate the last assistant response in plain language. Explain the existing answer without doing new
work.

## Hard rules

- Restate the last assistant response, not the request that triggered this skill.
- Write a few sentences: what happened, what it means, what to do next.
- Name real files, commands, and numbers instead of categories.
- Do not use jargon, tables, or raw tool output.
- Explain, do not re-run. Beyond loading this skill, make no tool calls, start no new investigation,
  and give no revised answer. If that response was wrong, fixing it is a new request.
- Report the same outcome that response reported. A failure stays a failure. Do not soften it into
  "mostly working" and do not turn a warning into a crisis.
- If that response asked a question or laid out a decision, restate the choice and what each option
  costs. Do not pick one. The decision is still the user's.
