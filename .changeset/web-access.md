---
'tau': minor
---

Bundle the `pi-web-access` package so Pi loads its `web_search` and `fetch_content` tools with Tau.
Tau checks at session start that both tools are registered and reports an extension error when
either is missing. TDD observations do not restrict either tool.
