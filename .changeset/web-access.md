---
'tau': minor
---

Bundle the `pi-web-access` package so Pi loads its `web_search` and `fetch_content` tools with Tau.
Tau checks at session start that both tools are registered and reports an extension error when
either is missing. The TDD guard passes both tools through, since it blocks every tool it does not
recognize and would otherwise reject them as unrecognized edits.
