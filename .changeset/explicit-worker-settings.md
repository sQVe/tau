---
'tau': minor
---

Start Pi workers from explicit settings: the requested or profile model as provider/id and the saved
Pi configuration. Tau no longer reloads the parent's extensions or fingerprints its runtime, so
workers on providers that register once per process, such as claude-bridge, launch again. A missing
worker model names the configured models. Follow-ups replay the saved model, thinking, cwd, and
agent directory only. Earlier task records are skipped as retired.
