---
'tau': minor
---

The `nextest` runner takes two new `tdd` keys. `cargoManifestPath` names the `Cargo.toml` to test,
resolved from the Git checkout root, so `run_tests` can run a project in a subdirectory such as
`backend/Cargo.toml`. Cargo runs from that manifest's directory, so it reads the project's
`.cargo/config.toml`. `cargoLocked: true` passes `--locked` to every Cargo command the runner runs,
so an out-of-date `Cargo.lock` fails the run instead of being rewritten. Freshness also fingerprints
the Cargo files beside the chosen manifest and each `Cargo.toml`, `Cargo.lock`, `.cargo/config`, and
`.cargo/config.toml` above it, or above the session directory, up to the Git checkout root. A failed
`cargo nextest list` now quotes Cargo's error.
