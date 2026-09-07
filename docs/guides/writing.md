# Writing

This guide holds Tau's writing rules. [ADR 0006](../adr/0006-default-writing-policy.md) makes this
file the single source of those rules and loads it into the agent prompt on every ordinary run.

## Where the rules apply

Apply them to replies, progress updates, commit and pull request text, tickets, docs, and code
comments. Docs and posts may have more personality, but use the same simple language.

## Write for a wide audience

- Write for readers who use English as a second language.
- Prefer common words and short sentences. Keep one idea per sentence.
- Explain technical terms when the reader may not know them.

## Cut what adds nothing

- Remove filler and repetition.
- Name your sources.
- Use formatting only where it helps the reader.
- End a reply without repeating the answer.
- Keep code comments that explain what the code cannot.

## Keep the meaning

- Keep the meaning, the sources, and any real uncertainty.
- Preserve exact text in quotations and code, and follow required formats.
- The task and repository rules come first.
- A request to edit comments is not permission to refactor code.

## Verify the result

Review the text silently before you send or save it. Check that it still says the same thing, that
each sentence carries one idea, and that nothing was added or lost.

## See also

- [ADR 0006: Default writing policy](../adr/0006-default-writing-policy.md)
- [Writing docs](../AGENTS.md)
