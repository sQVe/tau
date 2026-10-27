# Fallback pull request body

Use this shape when the repository has no pull request template. Leave out optional sections that
have nothing to say. Aim for 100 to 150 words of text you write, and never pass 200. Verification
lines do not count.

```markdown
**One sentence, in product words, that states what the PR changes for its type.**

One or two sentences of cause or constraint that the diff cannot show.

Optional parts list:

- A behavior in plain words, and its effect for the user or reviewer.

Optional: what stays disconnected, and the follow-up ticket when it exists.

#### Decisions

Optional. Only consequential choices, each with the rejected option and why. When the PR changes how
parts connect, add at most one diagram here as a top-level `mermaid` block, drawn with the diagram
skill.

#### Verification

- [x] A check or scenario that ran, and the behavior it exercised.
- [x] The review result, in one line.
- [ ] <Required action>. Done when <completion condition>.

Limitations, only when they affect reviewing, using, or deploying this change:

- A limitation in plain words.

##### Deferred verification

Optional. Only checks that can run after deployment.

- A check to run after deployment.

#### Deployment notes

Optional. Steps, order, or risks for whoever deploys the change.

Fixes #123
```

The closing line is optional.
