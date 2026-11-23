---
'tau': patch
---

`architect` `open` and the hidden route of `ask` take the architect lock before they start Pi. A
second caller is refused before it starts Pi or writes an ask record. A launch whose command ran but
whose reply was lost, invalid, or timed out is looked up by its launch identifier for up to 10
seconds. The caller stops a found terminal before it releases the claim, and keeps the claim while
the lookup fails. A hidden ask enforces its own deadline, and a reader fails a running ask whose
terminal has ended.
