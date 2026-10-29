---
'tau': patch
---

Worker launches no longer refuse every edit to the skill tool list until `/reload`. The list moves
from `src/skillTools.ts` to `src/skillTools.json`. A launch refuses only when the file lists a tool
this Pi session did not register, and the message names that tool and says to run `/reload`. A file
that cannot be read or parsed refuses the launch with a message to fix `src/skillTools.json`. Moving
a tool between skills launches without a reload, and each worker gets the tools the file assigns to
its skills.
