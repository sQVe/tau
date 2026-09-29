---
'tau': minor
---

Let a worker profile load its own Pi packages. A profile's `packages:` setting lists Pi package
sources, as `pi -e` takes them. Before it opens the pane, the parent installs each package into Pi's
temporary cache, and the worker loads it with `-e`. The parent session does not load it. A package
that the user or project settings already load is not loaded twice. A failed install stops the
launch and names the package. When the worker exits before it is ready, the failure names the
packages it loaded with `-e`.

The bundled `qa` profile now loads `npm:pi-agent-browser-native` itself and has a description. Users
whose parent session does not use the browser can remove the package from their settings.

Task records move to format 6, which saves the profile packages. Follow-ups of older tasks load no
profile packages.
