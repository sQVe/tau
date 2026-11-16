# Synthesis

Apply each criterion to every finding. Drop a finding that fails durability, specificity,
existing-skill-first, convergence, decision-changing, skill-was-used, or already-covered. The
structural criterion moves a finding to Backlog.

- Durability: still true in 6 months, after paths, commits, tool versions, and code shapes change.
- Specificity: broad enough to apply across tasks, precise enough that a future agent recognizes
  when it applies. Reject vague advice and one-off facts.
- Existing-skill-first: propose a new skill only when no existing skill is a real home, the pattern
  recurs, and the topic deserves its own skill.
- Convergence: a finding echoed by 2 or more lenses carries higher confidence. A single-lens finding
  must clear a higher bar on the other criteria.
- Decision-changing: a future agent does something different because of the change, not just reads
  more text.
- Structural: route to Backlog when a lint rule, script, metadata flag, or runtime check already
  enforces the rule or could enforce it cheaply. Skill prose is for what a check cannot enforce.
- Skill-was-used: accept only a finding that routes to a skill, tool, or instruction the transcripts
  used. When a skill should have fired but did not, route to a description tune. Otherwise reject
  it.
- Already-covered: read the target skill before accepting a body edit. Reject a duplicate of clear,
  well-placed guidance. When the guidance is buried or easy to skip, accept a wording or placement
  change that makes it fire.

## Structural rule

Move any Accepted row that a check could enforce to Backlog. A check is a lint rule, a test, a
script, a type, or a runtime guard. Keep prose for judgment.
