---
'tau': patch
---

Replace the ticket draft tool with `ticket` actions to prepare drafts, upsert comments by heading,
and cancel tickets after checking their state and linked pull requests. Keep saved comment IDs in
version 3 drafts, while still reading versions 1 and 2. Recheck ticket and comment state after
confirmation before writing. Add `read` and `apply` to create routed tickets from local drafts or
update only changed text, binding an existing ticket on its first update. Check the state token
before writing and ask before updating another person's ticket. Report the created ticket if saving
its identifier fails. Preserve unbound legacy comment IDs in ticket-named directories. Report
successful Linear comments when saving their IDs fails. Refuse cancellation if the confirmed title
or state name changes. Refuse a new ticket when an open ticket the viewer created in the route
already has the draft's title.
