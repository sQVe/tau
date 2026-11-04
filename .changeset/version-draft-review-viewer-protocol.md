---
'tau': patch
---

`draft_review` writes a versioned `request.json` into each review record. When a viewer writes a
versioned `comments.json` there, collect validates it and returns its comments instead of reading
tuicr.
