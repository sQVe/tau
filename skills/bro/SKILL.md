---
name: bro
description:
  Restate the last assistant response in plain language, covering what happened, what it means, and
  what to do next. Use it when the user asks to explain that, say it in plain English, or eli5. With
  a topic, such as `/bro what is this ticket for`, explain that topic instead. Not for redoing the
  work.
---

# Bro

## When to use

Use this skill when the user did not understand the last assistant response and asks for it in plain
language, or asks for a plain-language explanation of a topic.

## Goal

Without a topic, restate the last assistant response in plain language. With a topic, explain that
topic in plain language. Either way, explain without doing new work.

## Hard rules

- Name real files, commands, and numbers instead of categories.
- Do not use jargon, tables, or raw tool output.

### Without a topic

- Restate the last assistant response, not the request that triggered this skill.
- Write a few sentences: what happened, what it means, what to do next.
- Explain, do not re-run. Beyond loading this skill, make no tool calls, start no new investigation,
  and give no revised answer. If that response was wrong, fixing it is a new request.
- Report the same outcome that response reported. A failure stays a failure. Do not soften it into
  "mostly working" and do not turn a warning into a crisis.
- If that response asked a question or laid out a decision, restate the choice and what each option
  costs. Do not pick one. The decision is still the user's.

### With a topic

- Write a few sentences that answer the topic.
- Use the conversation first. Read the named source, such as the ticket, only when facts are
  missing.
- Change nothing, diagnose no new problem, and plan no implementation.
- If the topic or its source is unclear, ask instead of guessing.
