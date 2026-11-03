---
'tau': patch
---

The `stack` tool's decisions take normalized facts, so a required read that failed or never ran
gives `unknown` or `stop` instead of looking like "no stack". The `chain` action reads one pull
request view for a one-PR stack. It reads the default branch only when no GitHub stack gives the
trunk, so a failed default-branch read no longer stops a stacked chain.
