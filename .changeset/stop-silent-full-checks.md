---
'tau': patch
---

`full_check` now stops a check whose log gets no new output for 2 minutes. It ends the command's
process group and returns a failed result that says the check went silent and names the log. A hung
check no longer holds the machine-wide full check lock forever.
