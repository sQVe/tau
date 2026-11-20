# Synthesis

Apply each criterion to every finding. Drop a finding that fails durability, specificity,
existing-skill-first, convergence, decision-changing, skill-was-used, or already-covered.

- Durability: still true in 6 months, after paths, commits, tool versions, and code shapes change.
- Specificity: broad enough to apply across tasks, precise enough that a future agent recognizes
  when it applies. Reject vague advice and one-off facts.
- Existing-skill-first: propose a new skill only when no existing skill is a real home, the pattern
  recurs, and the topic deserves its own skill.
- Convergence: a finding echoed by 2 or more lenses carries higher confidence. A single-lens finding
  must clear a higher bar on the other criteria.
- Decision-changing: a future agent does something different because of the change, not just reads
  more text.
- Structural: move a finding to Backlog when its route is a Tau skill, tool, or instruction or a
  stomme rule, and a lint rule, test, script, type, metadata flag, or runtime guard already enforces
  the rule or could enforce it cheaply. Skill prose is for what a check cannot enforce. A repo
  proposal is not moved to Backlog for this reason. A stomme finding moves to Backlog, with the
  stomme repository named in the row.
- Repo proposal: one verified incident in the task's own repository may produce an Accepted row when
  the proposal is a concrete setup, fixture, test-command, CI, or verification change that could
  have prevented it. One incident is enough. The row states the repository, the observed gap, the
  change, and the past failure the change must catch. A row missing any of the four does not reach
  Accepted.
- Skill-was-used: accept only a finding that routes to a skill, tool, or instruction the transcripts
  used, to a repo proposal, or to a stomme rule. When a skill should have fired but did not, route
  to a description tune. Otherwise reject it.
- Already-covered: read the target skill before accepting a body edit. Reject a duplicate of clear,
  well-placed guidance. When the guidance is buried or easy to skip, accept a wording or placement
  change that makes it fire.
