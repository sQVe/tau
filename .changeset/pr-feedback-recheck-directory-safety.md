---
'tau': patch
---

`pr_feedback` checks the feedback directory again after the user confirms a post. If the directory
became a symlink during confirmation, post refuses without GitHub writes or a `posted.json` file
outside the checkout.
