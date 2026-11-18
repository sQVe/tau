---
'tau': minor
---

Load the `coding` instruction set from stomme. A project with `stomme.toml` gets its synced general,
language, and layer guides. Without `stomme.toml`, Tau loads its bundled general guide. Tau reads
the guides again at each run, in the main session and in workers. A broken installation shows an
error notice and a prompt line instead of the guides. Tau no longer ships its own coding
instructions file.
