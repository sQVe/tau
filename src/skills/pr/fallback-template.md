# Fallback pull request body

Use this shape when the repository has no pull request template. Leave out optional sections that
have nothing to say.

```markdown
**One sentence that states what the PR changes.**

At most three sentences of context: why the change is needed and what the diff cannot show.

#### Decisions

Optional. Consequential choices, each with its reason and trade-off.

#### Verification

- [x] A check that passed, such as `pnpm check`.
- [x] A complete review of the pushed content with no open findings.
- [x] Fixes accepted without a new review, when there are any, with what they fix.
- [ ] Failed: a required check that ran and failed, with what failed.
- [ ] Not run: a required check or review that is still missing, with why.

##### Deferred verification

Optional. Only checks that can run after deployment.

- A check to run after deployment.

#### Deployment notes

Optional. Steps, order, or risks for whoever deploys the change.

Fixes #123
```

The closing line is optional.
