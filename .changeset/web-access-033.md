---
'tau': minor
---

Update the bundled `pi-web-access` to 0.33.0 and load its compiled bundle. Parent sessions now start
with only `web_enable`, which turns on the web tools when the model needs them. Set
`"toolActivation": "eager"` in `~/.pi/agent/web-search.json` to keep them active from the first
turn. Workers whose profile lists web tools, such as `scout`, still get them active from the start.
