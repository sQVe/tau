---
name: Babysit CI
description: Watch CI or a deploy and fix failures
---

Watch the CI run or deploy for this PR or merge until it finishes, staging and production included. Use a background worker for long waits. When a job fails, read its log, fix the root cause, push the fix, and watch again. Check that the result really happened, not only that the job passed. Then report the final state.
