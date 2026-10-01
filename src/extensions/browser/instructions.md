# Tau browser instructions

Apply these rules to every `agent_browser` and `agent_browser_code` call. The browser uses a copy of
the user's agent Chrome profile, so it starts with the logins saved there.

- Use `sessionMode: "auto"`. To watch the browser, add `--headed` to the first browser call.
- Do not pass `sessionMode: "fresh"`, `--profile`, or `--executable-path` unless the task names
  another account. These calls start the browser without the configured profile.
- Do not create profile folders. Use a persistent profile folder only when the user approves it and
  the site needs state that the browser cannot restore.
- Check that the page shows you are signed in before you act as the user. A copied profile does not
  prove that the login is still valid.
- On a login wall, stop and ask the parent. Do not sign in inside the agent browser, because it
  discards its profile copy when it closes.
- Finish with the `close` command. Do not close a headed window by hand.
