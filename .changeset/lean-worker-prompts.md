---
'tau': patch
---

Workers get their profile and handoff rules in the system prompt instead of the first message, so
follow-ups do not resend them and compaction keeps them. The first message holds only the task and
its deadline. Worker prompts drop lines that tool descriptions already state, and the `qa` profile
now keeps its report under about 4,000 characters like `scout` and `reviewer`.
