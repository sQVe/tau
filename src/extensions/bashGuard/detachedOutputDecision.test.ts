import { expect, it } from 'vitest';

import { loggedClose, nohupClose } from '../../../tests/bashGuardCommands.js';
import { decideDetachedOutput } from './detachedOutputDecision.js';

const blocks = (command: string): boolean =>
  decideDetachedOutput({ toolName: 'bash', command })?.block === true;

it('blocks the past nohup close whose stderr went to /dev/null', () => {
  const decision = decideDetachedOutput({ toolName: 'bash', command: nohupClose });

  expect(decision?.block).toBe(true);
  expect(decision?.reason).toContain('> /tmp/<name>.log 2>&1');
});

it('allows the logged setsid close whose inner command writes a log', () => {
  expect(decideDetachedOutput({ toolName: 'bash', command: loggedClose })).toBeUndefined();
});

it.each<{ name: string; command: string; blocked: boolean }>([
  { name: 'a detached command that keeps stderr', command: 'cmd &', blocked: false },
  {
    name: 'a detached command with stderr to /dev/null',
    command: 'cmd 2>/dev/null &',
    blocked: true,
  },
  {
    name: 'a detached command with both streams to /dev/null',
    command: 'cmd &>/dev/null &',
    blocked: true,
  },
  {
    name: 'a foreground command that discards stderr',
    command: 'cmd >/dev/null 2>&1',
    blocked: false,
  },
  {
    name: 'a detached command that logs both streams',
    command: 'cmd > /tmp/x.log 2>&1 &',
    blocked: false,
  },
  {
    name: 'a nohup command that discards stderr',
    command: 'nohup cmd >/dev/null 2>&1 &',
    blocked: true,
  },
  {
    name: 'a setsid command that discards stderr',
    command: 'setsid cmd 2>/dev/null &',
    blocked: true,
  },
  { name: 'a detached append to /dev/null', command: 'cmd >>/dev/null 2>&1 &', blocked: true },
  {
    name: 'a detached command with an unnumbered ampersand to /dev/null',
    command: 'cmd >&/dev/null &',
    blocked: true,
  },
  {
    name: 'a detached pipeline whose first command discards stderr',
    command: 'cmd 2>/dev/null | cat &',
    blocked: true,
  },
  {
    name: 'a detached script that closes its stderr descriptor',
    command: "sh -c 'printf hidden >&2; false 2>&-' >/dev/null 2>&1 &",
    blocked: true,
  },
  {
    name: 'a detached command that logs both streams through an unnumbered ampersand',
    command: 'cmd >& /tmp/x.log &',
    blocked: false,
  },
  {
    name: 'a detached command that closes its stderr descriptor',
    command: 'cmd 2>&- &',
    blocked: true,
  },
  {
    name: 'a detached command before another command',
    command: 'cmd 2>/dev/null & echo done',
    blocked: true,
  },
  {
    name: 'a detached shell script with no inner redirect',
    command: "sh -c 'cmd' >/dev/null 2>&1 &",
    blocked: true,
  },
  {
    name: 'a detached shell script whose last command logs',
    command: "bash -c 'sleep 1; cmd > /tmp/x.log 2>&1' >/dev/null 2>&1 &",
    blocked: false,
  },
  {
    name: 'a detached setsid script whose inner command writes a log',
    command: loggedClose,
    blocked: false,
  },
  {
    name: 'a foreground pipeline that merges stderr into the pipe',
    command: 'printf example 2>/dev/null |& cat',
    blocked: false,
  },
  {
    name: 'a detached group whose command logs and whose group discards stderr',
    command: '( cmd > /tmp/x.log 2>&1 ) >/dev/null 2>&1 &',
    blocked: false,
  },
  {
    name: 'a detached group whose command does not log',
    command: '( herdr-app do space.close --confirmed ) >/dev/null 2>&1 &',
    blocked: true,
  },
  {
    name: 'a detached group whose own redirection logs',
    command: '( cmd ) > /tmp/x.log 2>&1 &',
    blocked: false,
  },
  {
    name: 'a detached group whose own redirection discards stderr',
    command: '( cmd ) >/dev/null 2>&1 &',
    blocked: true,
  },
  {
    name: 'a nested backgrounded group whose only real command logs',
    command: '( ( cmd > /tmp/x.log 2>&1 ) & ) >/dev/null 2>&1',
    blocked: false,
  },
  {
    name: 'a nested backgrounded group that inherits a discarded stderr',
    command: '( ( cmd ) & ) >/dev/null 2>&1',
    blocked: true,
  },
  {
    name: 'a backgrounded script that inherits a discarded stderr',
    command: "( sh -c 'cmd' & ) >/dev/null 2>&1",
    blocked: true,
  },
  {
    name: 'a |& pipeline discarding stderr',
    command: 'cmd 2>/dev/null |& cat &',
    blocked: false,
  },
  {
    name: 'a shell discarding inner stderr',
    command: `sh -c 'sh -c "printf hidden >&2; exit 17" 2>/dev/null' &`,
    blocked: true,
  },
  {
    name: 'a shell with a later inner discard',
    command: `sh -c 'true; cmd 2>/dev/null' &`,
    blocked: true,
  },
  {
    name: 'a shell cluster whose script logs',
    command: `nohup bash -lc 'cmd > /tmp/x.log 2>&1' >/dev/null 2>&1 &`,
    blocked: false,
  },
  {
    name: 'a shell script whose logging command is followed by a silent one',
    command: `setsid sh -c 'cmd > /tmp/x.log 2>&1; true' >/dev/null 2>&1 &`,
    blocked: true,
  },
  {
    name: 'a shell script whose last command inherits the discarded stderr',
    command: `sh -c 'echo start > /tmp/x.log 2>&1; cmd' >/dev/null 2>&1 &`,
    blocked: true,
  },
  {
    name: 'a shell script whose inner group discards stderr',
    command: `sh -c '( cmd ) 2>/dev/null' &`,
    blocked: true,
  },
  {
    name: 'a shell script whose inner group logs stderr',
    command: `sh -c '( cmd ) > /tmp/x.log 2>&1' >/dev/null 2>&1 &`,
    blocked: false,
  },
  {
    name: 'a detached group whose first command discards stderr and a later one logs',
    command:
      '( herdr-app do space.close --confirmed 2>/dev/null; echo done > /tmp/x.log 2>&1 ) >/dev/null 2>&1 &',
    blocked: true,
  },
  {
    name: 'a detached group whose last command inherits the discard',
    command:
      '( herdr-app do space.close --confirmed > /tmp/x.log 2>&1; sleep 1 ) >/dev/null 2>&1 &',
    blocked: true,
  },
  {
    name: 'a detached group whose last command logs',
    command: '( close; true > /tmp/x.log 2>&1 ) >/dev/null 2>&1 &',
    blocked: false,
  },
  {
    name: 'a detached command backgrounded inside a foreground group',
    command: '( cmd 2>/dev/null & )',
    blocked: true,
  },
  {
    name: 'a shell script whose nested script discards stderr',
    command: `sh -c 'sh -c "cmd 2>/dev/null"' &`,
    blocked: true,
  },
  {
    name: 'a heredoc body command before a background unit',
    command: 'cat <<EOF\n$(touch x 2>/dev/null)\nEOF\nother &',
    blocked: false,
  },
  {
    name: 'a detached pipeline broken across a newline whose first command discards stderr',
    command: 'nohup cmd 2>/dev/null |\n  cat &',
    blocked: true,
  },
  {
    name: 'a foreground command before a substitution with an inner background command',
    command: 'printf example 2>/dev/null; printf "%s" "$(true &)"',
    blocked: false,
  },
  {
    name: 'a detached and-list broken across a newline whose first command discards stderr',
    command: 'nohup cmd 2>/dev/null &&\n  other &',
    blocked: true,
  },
  {
    name: 'a detached or-list broken across a newline whose first command discards stderr',
    command: 'nohup cmd 2>/dev/null ||\n  other &',
    blocked: true,
  },
  {
    name: 'a foreground and-list broken across a newline',
    command: 'cmd 2>/dev/null &&\n  other',
    blocked: false,
  },
])('decides $name', ({ command, blocked }) => {
  expect(blocks(command)).toBe(blocked);
});

it('ignores another tool name', () => {
  expect(decideDetachedOutput({ toolName: 'read', command: 'cmd 2>/dev/null &' })).toBeUndefined();
});

it('ignores a command that is not a string', () => {
  expect(decideDetachedOutput({ toolName: 'bash', command: undefined })).toBeUndefined();
});
