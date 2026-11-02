---
'tau': minor
---

Workers can ask their manager a question again with `subagent_question`. Tau saves the question in
the worker's assignment file and sends the manager a short note. The manager sees each question
once, with the worker's `hc` address. It answers with `hc send <address> "<answer>"`. Tau never
forces a send, and a refused send is reported to the user.
