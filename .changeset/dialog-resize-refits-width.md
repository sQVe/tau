---
'tau': patch
---

Fail the dialog resize test when the message keeps the old width. The test changed the height and
width together and asserted only row counts, so a render at the old width still passed. It now holds
the height fixed and wraps a message line only at the narrower width, and a second test keeps the
height-change coverage.
