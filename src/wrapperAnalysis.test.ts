import { describe, expect, it } from 'vitest';

import { commandWords, runsRedirectionsOnlyExec } from './wrapperAnalysis.js';

describe('commandWords', () => {
  it.each([
    { name: 'a doas user option', words: ['doas', '-u', 'root', 'sh', '-c', 'cmd'] },
    { name: 'an env unset option', words: ['env', '-u', 'HOME', 'sh', '-c', 'cmd'] },
    { name: 'an env split string value', words: ['env', '-S', 'sh -c cmd'] },
    { name: 'an env split string attached value', words: ['env', '-Ssh -c cmd'] },
    { name: 'an env split string equals value', words: ['env', '--split-string=sh -c cmd'] },
    { name: 'an env chdir option', words: ['env', '--chdir', '/tmp', 'sh', '-c', 'cmd'] },
    { name: 'a nice adjustment', words: ['nice', '-n', '5', 'sh', '-c', 'cmd'] },
    { name: 'a stdbuf output option', words: ['stdbuf', '-oL', 'sh', '-c', 'cmd'] },
    { name: 'a stdbuf output value option', words: ['stdbuf', '-o', 'L', 'sh', '-c', 'cmd'] },
    { name: 'a sudo user option', words: ['sudo', '-u', 'root', 'sh', '-c', 'cmd'] },
    { name: 'a timeout signal option', words: ['timeout', '-s', 'TERM', '5', 'sh', '-c', 'cmd'] },
    { name: 'an xargs replace option', words: ['xargs', '-I', '{}', 'sh', '-c', 'cmd'] },
    {
      name: 'a chroot root argument',
      words: ['chroot', '--userspec', 'root', 'root', 'sh', '-c', 'cmd'],
    },
    { name: 'a flock lock file', words: ['flock', '-w', '5', '/tmp/lock', 'sh', '-c', 'cmd'] },
  ])('reads the command head past $name', ({ words }) => {
    expect(commandWords(words).words).toEqual(['sh', '-c', 'cmd']);
  });

  it('keeps an env split string that is not a leading wrapper', () => {
    expect(commandWords(['echo', 'env', '-S', 'a b'])).toEqual({
      words: ['echo', 'env', '-S', 'a b'],
      lookup: false,
    });
  });

  it('expands the split string of every leading env wrapper', () => {
    expect(commandWords(['env', '-i', 'env', '-S', 'sh -c cmd']).words).toEqual([
      'sh',
      '-c',
      'cmd',
    ]);

    expect(commandWords(['env', 'FOO=1', 'env', '-S', 'sh -c cmd']).words).toEqual([
      'sh',
      '-c',
      'cmd',
    ]);
  });

  it('stops reading env options at the first operand', () => {
    expect(commandWords(['env', 'echo', '-S', 'sh -c cmd']).words).toEqual([
      'echo',
      '-S',
      'sh -c cmd',
    ]);
  });

  it.each([
    { name: 'a negation', keyword: '!' },
    { name: 'a brace', keyword: '{' },
    { name: 'an if', keyword: 'if' },
    { name: 'a then', keyword: 'then' },
    { name: 'an elif', keyword: 'elif' },
    { name: 'an else', keyword: 'else' },
    { name: 'a do', keyword: 'do' },
    { name: 'a while', keyword: 'while' },
    { name: 'an until', keyword: 'until' },
  ])('reads the command head past $name keyword', ({ keyword }) => {
    expect(commandWords([keyword, 'sh', '-c', 'cmd']).words).toEqual(['sh', '-c', 'cmd']);
  });

  it('reads a wrapper operand after an option terminator', () => {
    expect(commandWords(['flock', '--', '-lockfile', 'bash', '-lc', 'cmd']).words).toEqual([
      'bash',
      '-lc',
      'cmd',
    ]);

    expect(commandWords(['command', '--', '-v', 'hc', 'send']).words).toEqual(['-v', 'hc', 'send']);
  });

  it('reads the command after a wrapper time as the external binary', () => {
    expect(commandWords(['command', 'time', '-v', 'hc', 'send']).words).toEqual(['hc', 'send']);

    expect(commandWords(['time', '-v', 'hc', 'send']).words).toEqual(['-v', 'hc', 'send']);
  });

  it('reads the command the external time binary runs', () => {
    expect(commandWords(['/usr/bin/time', '-o', '/tmp/log', 'hc', 'send']).words).toEqual([
      'hc',
      'send',
    ]);
  });

  it('treats only -p and -- as the reserved time word options', () => {
    expect(commandWords(['time', '-p', 'hc', 'send']).words).toEqual(['hc', 'send']);
    expect(commandWords(['time', '--', 'hc', 'send']).words).toEqual(['hc', 'send']);
    expect(commandWords(['time', '--', '-p', 'hc', 'send']).words).toEqual(['-p', 'hc', 'send']);

    expect(commandWords(['time', '-o', '/tmp/log', 'hc', 'send']).words).toEqual([
      '-o',
      '/tmp/log',
      'hc',
      'send',
    ]);
  });

  it('reads the command flock runs after the lock file and its other options', () => {
    expect(
      commandWords(['flock', '/tmp/lock', '-w', '5', 'sh', '-c', 'cmd 2>/dev/null']).words,
    ).toEqual(['sh', '-c', 'cmd 2>/dev/null']);
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'treats the %s command name as an ordinary command',
    (name) => {
      expect(() => commandWords([name, '-x'])).not.toThrow();
      expect(commandWords([name, '-x'])).toEqual({ words: [name, '-x'], lookup: false });
    },
  );

  it('marks a command lookup instead of a command', () => {
    expect(commandWords(['command', '-v', 'sh', '-c', 'cmd'])).toEqual({
      words: ['sh', '-c', 'cmd'],
      lookup: true,
    });

    expect(commandWords(['command', '-p', '--', 'hc', 'send'])).toEqual({
      words: ['hc', 'send'],
      lookup: false,
    });
  });
});

it.each([
  { name: 'a bare exec', words: ['exec'], runs: true },
  { name: 'an exec with a name option', words: ['exec', '-a', 'name'], runs: true },
  { name: 'a negated exec', words: ['!', 'exec'], runs: true },
  { name: 'a timed exec', words: ['time', 'exec'], runs: true },
  {
    name: 'a timed exec after the portability flag',
    words: ['time', '-p', 'exec'],
    runs: true,
  },
  {
    name: 'a timed exec after an external time output option',
    words: ['/usr/bin/time', '-o', '/tmp/x.log', 'exec'],
    runs: false,
  },
  { name: 'a command-qualified exec', words: ['command', 'exec'], runs: true },
  { name: 'a builtin-qualified exec', words: ['builtin', 'exec'], runs: true },
  {
    name: 'a time word after a qualifier',
    words: ['command', 'time', 'exec'],
    runs: false,
  },
  { name: 'an exec that runs a command', words: ['exec', 'cmd'], runs: false },
  { name: 'an env exec', words: ['env', 'exec'], runs: false },
  { name: 'a sudo exec', words: ['sudo', 'exec'], runs: false },
  { name: 'a command lookup of exec', words: ['command', '-v', 'exec'], runs: false },
  { name: 'a command that is not exec', words: ['cmd'], runs: false },
])('decides whether $name changes this shell', ({ words, runs }) => {
  expect(runsRedirectionsOnlyExec(words)).toBe(runs);
});
