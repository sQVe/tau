# ADR 0049: Treat the bash commit guard as guidance

- Status: Accepted
- Date: 2026-09-25

## Context

The bash guard blocks `git commit` so agents use the `commit` tool. It matched one regex against the
whole command, so it also blocked commands that only mention a commit in quoted text or heredoc
bodies, such as a `gh pr create` body. Agents then reworded the same command to get past it.

A review of a parsing fix listed many shell constructs that still run `git commit` without being
blocked: odd quoting, arithmetic, expansions as the command name, `trap`, `source`, and interpreter
code such as `python3 -c`.

## Options considered

- Keep the regex. It blocks harmless commands and trains agents to reword around it.
- Treat the guard as a security boundary and close every bypass, with a full shell parser dependency
  or ever more parser cases. The commit tool exists for workflow, not containment, and an agent that
  wants to evade the guard has many other ways to run Git.
- Treat the guard as guidance. Block the forms an agent writes by accident and let quoted data pass.

## Decision

Treat the bash commit guard as guidance that steers agents to the `commit` tool, not as a security
boundary.

- Block `git commit` where the shell runs it directly, and in text that a shell or Git runs as code.
- Let quoted arguments, comments, and heredoc bodies pass as data.
- When a command does not parse, fall back to the stricter regex.
- Accept bypasses through deliberate evasion, such as variables, unusual quoting, or other
  interpreters.

## Tradeoffs

- Commands that only mention a commit in data no longer block.
- A small parser covers the forms agents actually write.
- Cost: an agent that tries to evade the guard can still run `git commit` through bash.
- Cost: some false positives remain, such as `git log --grep commit` and quoted mentions in a
  command that also runs a shell.
