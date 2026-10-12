# Fallback pull request body

Use this shape when the repository has no pull request template. Keep the body to about 100 to 150
words and never past 200. Leave out optional sections that have nothing to say. Keep review history,
SHAs, and test counts out of the body.

```markdown
**One sentence that states what the PR changes.**

One or two sentences of cause or constraint that the diff cannot show.

#### Decisions

Optional. Only consequential choices, each with the rejected option and why. Do not narrate the
diff. When the PR changes how parts connect, add at most one diagram here as a top-level `mermaid`
block, drawn with the diagram skill.

#### Verification

- [x] A check or scenario that ran, and the behavior it exercised.
- [x] The review result, in one line.
- [ ] Untested: a behavior the checks and review did not cover, with why.
- [ ] Failed or not run: a required check, with what failed or why it is missing.
- [ ] Open finding: a review finding that is not closed, with what it is.
- [ ] Fixes after the review were not reviewed, only when this changes confidence.

##### Deferred verification

Optional. Only checks that can run after deployment.

- A check to run after deployment.

#### Deployment notes

Optional. Steps, order, or risks for whoever deploys the change.

Fixes #123
```

The closing line is optional.
