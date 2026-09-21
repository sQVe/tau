---
name: Review tests
description: Have a worker without this conversation find what the new tests would miss
placement: append
order: 95
---

Hand the tests added or changed in this session to an investigator subagent that has not seen this conversation. If no subagent can launch, say so instead of reviewing them yourself. Give it the diff and the stated goal, not your reasoning or conclusions. For each test, ask it to name one concrete change to the production code that would break the behavior and still let the test pass. If it finds none for a test, it should say so. Then ask it to flag tests that pin wording, internal calls, or constants instead of behavior a caller can observe. Treat its findings as claims to verify, not a task list. Report what it found, which findings hold up against the code, and what you recommend. Change no files yet.
