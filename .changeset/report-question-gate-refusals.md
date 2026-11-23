---
'tau': patch
---

Report a question gate config or allowlist refusal once per session instead of dropping it. A decide
config refusal asks the dialog as usual and writes no decision record. A refused shadow model skips
shadow sampling for that dialog, with no judge call and no shadow record.
