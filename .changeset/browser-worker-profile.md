---
'tau': minor
---

Add a bundled `browser` subagent profile for browser work the manager delegates, such as lookups,
forms, page checks, and screenshots. It loads `npm:pi-agent-browser-native` and does not edit the
worktree. The manager now sends browser work to it. When a worker needs a login, the manager asks
the user to sign in once in the browser package's Chrome profile, then starts a new worker. Set
`browser.loginCommand` in the user `tau.json` to have the manager name the command that opens that
profile. Only the user file may set it.

Add a `browser` instruction set with the rules that keep the configured Chrome profile: automatic
sessions, no explicit profile or browser path, no new profile folders, a check that the page is
signed in, a stop on a login wall unless the task gives credentials, and the `close` command at the
end. The `browser` and `qa` profiles load it. Profiles without `instruction-sets:` still load
`writing`, `coding`, and `workflow`, and the manager does not load the browser rules.

Task records move to format 7, which allows the `browser` set. Follow-ups of older tasks keep their
sets.

After this release, remove `npm:pi-agent-browser-native` from `packages` in your Pi settings if the
manager should no longer use the browser itself.
