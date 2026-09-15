---
'tau': patch
---

Clarify the unattended commit flow and retries after hook or comment review failures. Use the shared
Git helper for staging and path queries so interrupted commands stop the commit flow. Preserve their
lack of a timeout while keeping existing review calls bounded.
