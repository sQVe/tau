import { expect, it } from 'vitest';

import { decideDetachedOutput } from './detachedOutputDecision.js';

const blocks = (command: string): boolean =>
  decideDetachedOutput({ toolName: 'bash', command })?.block === true;

const nohupClose =
  'nohup sh -c \'sleep 30; herdr-app do space.close --id sp527dd22aa065042833adf82c857c6cab --confirmed\' >/dev/null 2>&1 & echo "close scheduled"';

const loggedClose =
  "setsid sh -c 'sleep 25; herdr-app do space.close --id sp527dd22aa065042833adf82c857c6cab --confirmed true > /tmp/tau-space-close.log 2>&1' </dev/null >/dev/null 2>&1 &";

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
    name: 'a foreground pipeline that merges stderr and has no trailing ampersand',
    command: 'cmd 2>/dev/null |& cat',
    blocked: false,
  },
  {
    name: 'a detached pipeline that merges stderr and whose first command discards stderr',
    command: 'cmd 2>/dev/null |& cat &',
    blocked: true,
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
