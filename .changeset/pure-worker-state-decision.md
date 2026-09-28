---
'tau': patch
---

Separate reading a worker's records from deciding its state. Worker state is unchanged; a test now
keeps registered decision modules free of record reads, the clock, randomness, and the environment.
