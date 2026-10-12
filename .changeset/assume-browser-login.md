---
'tau': patch
---

The manager now starts `browser` and `qa` workers as if the agent Chrome profile is already signed
in. It asks you to sign in only after a worker reports a login page. The `qa` profile and the
browser instructions now tell workers to open the page before they ask about a login.
