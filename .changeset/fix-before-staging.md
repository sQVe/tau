---
'tau': minor
---

Configure commit commands with optional `prepare` and `check` argv arrays in root `tau.json`.
Preparation runs once per call before staging. Checks use the staged candidate's own config. Remove
package-script and package-manager discovery; report missing commands without fallback. Reject
malformed or unknown settings, and tell users to rename obsolete `fix` to `prepare`. Reserve and
reject `checkMessage` and `hooks` until message checks and hook opt-out are implemented. Keep Git
hooks and commit guards in place. Tau's staged hook checks lint and formatting without rewriting
approved files.
