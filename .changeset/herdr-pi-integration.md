---
'tau': patch
---

Refuse Pi worker launch and follow-up before any herdr pane command when the parent's loaded
extensions omit herdr's Pi integration. The error names the cause and
`herdr integration install pi`. When herdr reports a started Pi worker without an `agent_session`,
the failure detail names herdr's Pi integration instead of a generic identity error. Generic workers
do not need the integration.
