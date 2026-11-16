---
'tau': patch
---

Each manager session start now sweeps new Pi transcripts and merged pull requests in the background,
with a 20-second budget and no model. It saves a `merge` event per merged pull request, and a
`facts` event once a transcript maps to the pull request's task, in each project root. A byte cursor
per transcript in `tau/improvement/index.json` under the agent directory lets later sweeps read only
new bytes. A worker session runs no sweep.
