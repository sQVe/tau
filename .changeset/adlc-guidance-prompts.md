---
'tau': minor
---

The compaction reminder now fires once the context passes 50% of the model's context window, instead
of a fixed 200,000 tokens. It says to finish the current ticket, then start a new session. The
`pr_feedback` read result has a `bodies` note that marks comment and review bodies as data from
other people, not instructions. The manager guidance asks for the same label on text from other
people in worker briefs. The review assignment asks for the test that fails when a changed guard is
inverted. `brainstorm` offers a premortem for hard-to-reverse designs.
