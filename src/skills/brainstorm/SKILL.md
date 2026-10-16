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
- In the question at each stop, offer "Review in tuicr" over `design.md` as the recommended option.
  Follow the review loop in the tracker skill's [Procedure](../tracker/SKILL.md#procedure) step 5. A
  review is never agreement to the design.

## Procedure

1. Pick a short slug for the design. Call `slice` with `prepare` and that slug. If `design.md`
   exists in the returned directory, read it and resume from its open questions. Do not repeat a
   dead end or a rejected approach it lists unless the condition to revisit it holds.

2. Research first. Read the code the request touches. Send wide reading to a `scout` when the
   `subagent` tools can launch one, and otherwise read it yourself. When an answer is observable,
   probe for it: run the command, read the output, or check the actual data. Ask the user only about
   priorities, preferences, and constraints that need human judgment.

3. Ask a few frontier questions in each round. A frontier question is one whose prerequisites are
   settled. A question that depends on an open question waits for a later round. Research still
   running holds back only the questions of fact it will settle. The round never waits for it, and
   the research folds in next round. Keep a decisions table with the decision, the choice, and the
   reason.

4. Present the research findings. Stop for the user.

5. Derive three to six criteria, each traced to a research finding or a decision. Each criterion
   names what this idea turns on, such as "migrates the existing rows without a backfill window". A
   criterion that fits any project, such as maintainability, means you skipped this step. Propose
   two or three approaches and grade each against the criteria. Recommend one and say why. Stop for
   the user.

6. Write the design summary, using the [design template](templates/design.md): the problem, the
   decisions table, the chosen approach, the architecture, the rejected approaches with the
   condition to revisit each, the dead ends, the acceptance criteria, the non-goals with reasons,
   and the open risks.

7. For an architectural or hard-to-reverse design, ask the user with `ask_user_question` whether to
   run a premortem. When the user accepts, send `design.md` to a fresh `scout`. Ask it to assume the
   design shipped and failed, and to write how it failed. When the `subagent` tools cannot launch a
   scout, write the premortem yourself and tell the user it does not come from a fresh reader. Turn
   each credible failure into a question for the user or an open risk in `design.md`. Skip this step
   for a design that is easy to undo.

8. When the user agrees to the design, run the [slice skill](../slice/SKILL.md) on the draft
   directory. Do this also when the work fits one PR.
