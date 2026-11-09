---
'tau': patch
---

Inside a slice, the manager no longer reviews each finished agent ticket. It reviews one only when a
later ticket builds on a contract it changes. start-slice reviews the whole slice once and sends its
findings to one fix round. Every review now gets at most one fix review, and findings left after it
go to the user.
