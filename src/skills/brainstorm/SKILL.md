---
name: brainstorm
description:
  Turn an unclear request into an agreed design through research and rounds of questions, saving the
  design after each round. Use it for "let's brainstorm", "help me design this", "I want to build X
  but I'm not sure how", or "what are the options for this". It does not split a design into slices;
  the `slice` skill does.
---

# Brainstorm

## When to use

Use this skill when the user describes something to build and the approach or the requirements are
unclear. Do not use it for a design the user already agreed on. Use the
[slice skill](../slice/SKILL.md) for that.

## Hard rules

- Write nothing to Linear.
- Save files only in the directory the `slice` tool's `prepare` action returns for the design's
  slug, such as `.tau/slices/add-dark-mode`.
- Ask every question with `ask_user_question`, at most four per call.
- Work one round at a time. Stop for the user where a step says so.
- Before each stop for the user, update `design.md` in the directory from step 1 with the decisions
  so far, the findings, and the open questions. A later session can then resume from it.

## Procedure

1. Pick a short slug for the design. Call `slice` with `prepare` and that slug. If `design.md`
   exists in the returned directory, read it and resume from its open questions.

2. Research first. Read the code the request touches. Send wide reading to a `scout` when the
   `subagent` tools can launch one, and otherwise read it yourself. Ask the user only what needs
   human judgment, never what the code can answer.

3. Ask a few frontier questions in each round: the open questions that block the most other
   decisions. Keep a decisions table with the decision, the choice, and the reason.

4. Present the research findings. Stop for the user.

5. Derive criteria from the decisions. Propose two or three approaches and grade each against the
   criteria. Recommend one and say why. Stop for the user.

6. Write the design summary, using the [design template](templates/design.md): the problem, the
   decisions table, the chosen approach, the acceptance criteria, the non-goals with reasons, and
   the open risks.

7. When the user agrees to the design, run the [slice skill](../slice/SKILL.md) on the draft
   directory. Do this also when the work fits one PR.
