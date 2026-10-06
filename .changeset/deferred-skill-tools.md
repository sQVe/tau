---
'tau': patch
---

Skill evidence scripts can call their tools without activation, including after a session reload or
resume and after reading another copy of a skill. Unused skill tools stay out of the prompt. When a
script still reports a missing skill tool, the error says the session must allow the tool in
`--tools` and `--exclude-tools`.
