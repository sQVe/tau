# Tau browser instructions

Apply these rules to every `agent_browser` and `agent_browser_code` call. The browser uses a copy of
the user's agent Chrome profile, so it starts with the logins saved there.

- Use `sessionMode: "auto"`. To watch the browser, add `--headed` to the first browser call.
- Do not pass `sessionMode: "fresh"`, `--profile`, or `--executable-path` unless the task names
  another account or the user approved a persistent profile. These calls start the browser without
  the configured profile.
- Do not create profile folders. Use a persistent profile folder only when the user approves it and
  the site needs state that the browser cannot restore.
- Check that the page shows you are signed in before you act as the user. A copied profile does not
  prove that the login is still valid.
- On a login wall, sign in only with credentials the task gives you, such as a test account.
  Otherwise, stop and ask the parent. A login inside the agent browser never reaches the Chrome
  profile it copied, so other and later workers do not get it.
- Finish with the `close` command. Do not close a headed window by hand.
