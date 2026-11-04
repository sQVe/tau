---
'tau': patch
---

TDD: add the `nextest` runner for Rust projects. Set `tdd.runner` to `nextest` to run tests with
`cargo nextest`. The runner builds the tests with `cargo nextest list`, then runs them with
`cargo nextest run` under one deadline. It reads results only from a JUnit report in the diagnostics
directory. It keeps each test's binary ID and reports a per-test timeout as a timeout. When
`cargo-nextest` is not on `PATH`, the result says how to install it. Results do not name a test file
yet, so a nextest run cannot establish RED.
