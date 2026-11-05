---
'tau': patch
---

Rust test results now carry an attribution. The nextest runner parses `cargo nextest list` JSON and
`cargo metadata`, reads each binary's dep-info file, and scopes a focused run to the binaries that
contain the requested files. A result is exact when its binary's dep-info lists exactly one
requested file, ambiguous when it lists several or when the same test name is in two binaries, and
unknown when it lists no requested file or has no dep-info. The binary may be built from other files
too, so another file in the same binary can match. Only an exact result can establish RED. A missing
dep-info file makes a binary's results unknown, never no-tests-collected. Crates without a library
target now run.
