---
'tau': minor
---

Update the bundled `pi-web-access` to 0.33.0 and load its compiled bundle. Parent sessions now start
with only `web_enable`, which turns on the web tools when the model needs them. To keep them active
from the first turn, set `"toolActivation": "eager"` in the `web-search.json` pi-web-access already
reads: `~/.pi/agent/web-search.json`, or `~/.pi/web-search.json` when only that one exists. Workers
whose profile lists web tools, such as `scout`, still get them active from the start.
