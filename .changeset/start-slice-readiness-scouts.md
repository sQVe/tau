---
'tau': minor
---

The start-slice skill now checks each new agent ticket with a fresh `scout` before the slice starts.
The scout reads only the ticket and the files it names, and lists what it would ask before starting
the work. The manager revises the ticket or proceeds, and the start report lists each scout's
questions. The check never blocks the start.
