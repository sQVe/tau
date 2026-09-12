---
'tau': minor
---

Configure commit commands with optional `prepare` and `check` argv arrays in root `tau.json`.
Preparation runs once per executed staged group. Checks use the staged candidate's own config.
Remove package-script and package-manager discovery; report missing commands without fallback.
Reject malformed or unknown settings, and tell users to rename obsolete `fix` to `prepare`. Message
checks and hook policy are now selected by the staged candidate. Keep human Git hooks and commit
guards independent of Tau's final-commit hook policy. Tau's staged hook checks lint and formatting
without rewriting approved files.
