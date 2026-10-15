---
'tau': minor
---

TDD freshness checks list their input files with one directory walk instead of `glob`. In
measurements, `glob` took 0.1 to 1.8 seconds per fingerprint, and the walk takes tens of
milliseconds. The walk follows every symlinked folder, so changes behind a link mark test results as
stale. It also hashes `.pi/tau.json`.

TDD config globs must use a supported subset: literal segments, `*`, `**`, `?`, comma brace groups,
a leading `./`, and numeric ranges such as `{1..3}`. Loading a config with other syntax fails with
an error that names the glob. Unsupported syntax includes escapes, bracket classes, letter or
zero-padded ranges, and braces that expand to more than 1000 patterns.
