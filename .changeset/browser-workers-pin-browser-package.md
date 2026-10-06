---
'tau': patch
---

The `qa` and `browser` worker profiles now load `pi-agent-browser-native` 0.9.3. With the earlier
cached version, every `agent_browser_code` call timed out before it reached the browser when Pi runs
as the compiled binary. The tool now needs Node on `PATH`. The browser instructions now say to run
`get url` after `eval`, `back`, `forward`, `reload`, `state load`, or a tab switch, and to retry
with `get url` when a call fails because the page is unverified.
