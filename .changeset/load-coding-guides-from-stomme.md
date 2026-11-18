---
'tau': minor
---

Load the `coding` instruction set from stomme. A project with `stomme.toml` gets its synced general,
language, and layer guides. Without `stomme.toml`, Tau loads its bundled general guide. Tau reads
the guides again at each run, in the main session and in workers. A broken installation shows an
error notice and a prompt line instead of the guides. Tau no longer ships its own coding
instructions file. Without `stomme.toml`, Tau loads its bundled TypeScript or Rust guide when a
session first reads or changes a file of that language. The `/rust-rules` command loads the Rust
guide, like `/typescript-rules` for TypeScript. In a stomme project, the project's language guide
loads with the coding guides, and these first-access rules stay off.
