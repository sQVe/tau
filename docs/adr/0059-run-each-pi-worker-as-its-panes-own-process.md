# ADR 0059: Run each Pi worker as its pane's own process

- Status: Accepted
- Date: 2026-09-28
- Supersedes: the "failed cleanup can require manual action" cost in
  [ADR 0028](./0028-keep-worker-control-in-the-parent.md) and the manual cleanup rule in
  [ADR 0043](./0043-own-only-the-worker-guarantees-herdr-lacks.md)

## Context

Tau started a Pi worker by splitting a pane, which starts the user's interactive shell, and then
typing `pi --session …` into that shell. To stop the worker, Tau sent keys, waited for the shell to
be bare again, and closed the pane. A scan on 2026-09-28 of the 235 worker records in
`~/.pi/agent/tau/` found:

- 6 workers left a pane open. In 3, cleanup used its whole 5 s budget. In 3, the shell check refused
  to close the pane after about 0.1 s.
- 4 launches failed with "Native start requires an unchanged foreground shell". Each left a "Tau
  workers" tab that holds only a shell.
- All six records that left a pane open still say `stopped: true`, so the widget and recovery never
  flag them.

The shell causes each failure:

- zsh prompt hooks, such as powerlevel10k, briefly show a forked zsh as the foreground group leader.
  The shell check reads that as a real job and refuses to close the pane.
- The stop keys `escape ctrl+c ctrl+d` do not stop Pi. The user binds `ctrl+d` to another action,
  and one `ctrl+c` only clears the editor.
- The user's `pi` is a shell function, so the typed command depends on the user's shell setup.

Herdr 0.9.1 can run a command as a pane's own process. The socket request `layout.apply` creates a
new tab whose single pane runs a given argv with a cwd, label, and environment. The pane has no
shell: `shell_pid` is the Pi process. When that process exits, herdr removes the pane and its tab.
`herdr pane close` stops the process with HUP, then TERM, then KILL. `herdr pane move` can place
that pane beside another pane, and herdr removes the empty source tab.

## Options considered

- Keep the shell and fix each check: resample prompt hooks longer, send `ctrl+c` twice, and retry
  keys. Each fix depends on the user's shell and key bindings, which Tau does not control.
- Start the shell with `exec pi …`. The shell still runs prompt hooks first, and `exec pi` finds the
  shell function, not the executable.
- Run Pi as the pane's own process. The pane then lives exactly as long as Pi, and no shell state
  remains to check. Choose this option.
- Ask herdr for a lease that closes a worker pane when its owner goes away. This is a herdr change,
  and it is out of scope here.

## Decision

Every Pi worker runs as its pane's own process, so a pane lives exactly as long as its Pi.

### Launch

Create the worker with `layout.apply` and a single-pane root whose `command` is the absolute `pi`
executable from `PATH` with the worker arguments. Pass the cwd and the worker environment in the
same request. Never pass `tab_id`, because that replaces an existing tab. A foreground worker then
moves beside its parent. A background worker moves into an owned background tab, or stays in its new
tab. Placement stays serialized.

The worker environment is the parent's environment plus Tau's worker variables. A direct pane does
not run the user's shell startup files, and the parent Pi was started from that shell, so its
environment carries settings such as `PATH` that the typed command used to get.

### Lifecycle

- Task done: Pi exits by itself after `agent_settled`, and herdr removes the pane.
- Cancel or deadline: the parent checks the terminal, the process ID and start time, and the Pi
  session in herdr, then calls `herdr pane close`. The parent never types into a worker to stop it.
- Parent death: the worker watches its parent and exits when the parent is gone. This is a
  follow-up.
- Restored session: a guard that every Pi session loads refuses to run a worker session file that
  has no bound task record. This is a follow-up.

### Records

A Pi ownership record states that the shell process is the worker process. Older Pi ownership
records describe a shell and are retired, as
[ADR 0052](./0052-drop-backwards-compatibility-by-default.md) allows.

Recording "process stopped" and "pane closed" as separate facts is a follow-up. Today one `stopped`
flag covers both, which hid the six open panes.

### Herdr restart

Herdr saves each pane's launch argv, but it runs that argv again only for panes handed over live by
`herdr update --handoff`. After a cold restart, a pane with a Pi session and
`resume_agents_on_restore = true` gets the user's default shell running `pi --session <file>`. That
command has neither Tau's environment nor its worker extensions. Any other pane gets a plain shell.
So direct panes do not prevent a restored worker, and the restored-session guard is still needed.
Source: herdr v0.9.1 `src/persist/restore.rs`, `src/app/agent_resume.rs`, and `src/agent_resume.rs`.

## Tradeoffs

- A finished or stopped Pi worker leaves no pane or tab behind, whatever the user's shell and key
  bindings are.
- Stopping no longer waits for a bare shell, so a stop takes one checked close instead of a keypress
  loop.
- Cost: `layout.apply` has no CLI command in herdr 0.9.1, so Tau sends it over herdr's socket.
- Cost: every worker first appears in its own tab, and then moves. A tab can flash in the tab bar
  during placement.
- Cost: until the follow-ups land, a worker whose parent dies keeps running, and herdr can restore a
  worker session outside Tau.
