import { describe, expect, it } from 'vitest';

import { shellScriptOf } from './shellScript.js';
import { commandWords, runsRedirectionsOnlyExec } from './wrapperAnalysis.js';

describe('commandWords and shellScriptOf', () => {
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
    expect(shellScriptOf(words)).toBe('cmd');
  });

  it('keeps an env split string that is not a leading wrapper', () => {
    expect(commandWords(['echo', 'env', '-S', 'a b'])).toEqual({
      words: ['echo', 'env', '-S', 'a b'],
      lookup: false,
    });
  });

  it('reads the -c script past a long shell option that contains c', () => {
    expect(shellScriptOf(['bash', '--rcfile=/tmp/rc', '-c', 'hc send'])).toBe('hc send');
    expect(shellScriptOf(['bash', '--rcfile', '/tmp/rc', 'script.sh'])).toBeUndefined();
    expect(shellScriptOf(['bash', '--rcfile', '/tmp/rc', '-c', 'hc send'])).toBe('hc send');
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
    const words = [keyword, 'sh', '-c', 'cmd'];

    expect(commandWords(words).words).toEqual(['sh', '-c', 'cmd']);
    expect(shellScriptOf(words)).toBe('cmd');
  });

  it('reads the -c script only before a shell operand', () => {
    expect(shellScriptOf(['bash', 'script.sh', '-c', 'hc send'])).toBeUndefined();
    expect(shellScriptOf(['sh', '--', 'script', '-c', 'hc send'])).toBeUndefined();
    expect(shellScriptOf(['bash', '-x', 'script.sh', '-c', 'hc send'])).toBeUndefined();
    expect(shellScriptOf(['bash', '-o', 'pipefail', '-c', 'cmd'])).toBe('cmd');
    expect(shellScriptOf(['bash', '-euo', 'pipefail', '-c', 'cmd'])).toBe('cmd');
    expect(shellScriptOf(['bash', '--rcfile', '/tmp/rc', '-c', 'cmd'])).toBe('cmd');
    expect(shellScriptOf(['bash', '-lc', 'cmd'])).toBe('cmd');
  });

  it('reads the script after a flag word that sets -c and takes a value', () => {
    expect(shellScriptOf(['bash', '-co', 'pipefail', 'cmd 2>/dev/null &'])).toBe(
      'cmd 2>/dev/null &',
    );

    expect(shellScriptOf(['bash', '-cO', 'pipefail', 'cmd'])).toBe('cmd');
  });

  it('reads the script after an option terminator that never names the script', () => {
    expect(shellScriptOf(['bash', '-co', 'pipefail', '--', 'cmd'])).toBe('cmd');
    expect(shellScriptOf(['bash', '-c', '--', 'cmd'])).toBe('cmd');
    expect(shellScriptOf(['bash', '-c', '--'])).toBeUndefined();
  });

  it('reads a wrapper operand after an option terminator', () => {
    const words = ['flock', '--', '-lockfile', 'bash', '-lc', 'cmd'];

    expect(commandWords(words).words).toEqual(['bash', '-lc', 'cmd']);
    expect(shellScriptOf(words)).toBe('cmd');

    expect(commandWords(['command', '--', '-v', 'hc', 'send']).words).toEqual(['-v', 'hc', 'send']);
  });

  it('reads a combined flag word that gives its value to -o before -c', () => {
    expect(shellScriptOf(['bash', '-oc', 'cmd'])).toBeUndefined();
    expect(shellScriptOf(['bash', '-lc', 'cmd'])).toBe('cmd');
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

    expect(shellScriptOf(['/usr/bin/time', '-o', '/tmp/log', 'sh', '-c', 'cmd'])).toBe('cmd');
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

  it('reads a flock script option before and after the lock file', () => {
    expect(shellScriptOf(['flock', '-c', 'cmd 2>/dev/null', '/tmp/lock'])).toBe('cmd 2>/dev/null');
    expect(shellScriptOf(['flock', '/tmp/lock', '-c', 'cmd 2>/dev/null'])).toBe('cmd 2>/dev/null');
  });

  it('reads a flock script from an inline option value', () => {
    expect(shellScriptOf(['flock', '--command=cmd 2>/dev/null', '/tmp/lock'])).toBe(
      'cmd 2>/dev/null',
    );
  });

  it('reads a flock script option after the lock file and its other options', () => {
    expect(shellScriptOf(['flock', '/tmp/lock', '-w', '5', '-c', 'cmd 2>/dev/null'])).toBe(
      'cmd 2>/dev/null',
    );
  });

  it('reads the command flock runs after the lock file and its other options', () => {
    const words = ['flock', '/tmp/lock', '-w', '5', 'sh', '-c', 'cmd 2>/dev/null'];

    expect(commandWords(words).words).toEqual(['sh', '-c', 'cmd 2>/dev/null']);
    expect(shellScriptOf(words)).toBe('cmd 2>/dev/null');
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'treats the %s command name as an ordinary command',
    (name) => {
      expect(() => commandWords([name, '-x'])).not.toThrow();
      expect(commandWords([name, '-x'])).toEqual({ words: [name, '-x'], lookup: false });
      expect(shellScriptOf([name, '-x'])).toBeUndefined();
    },
  );

  it('joins the words watch hands to its shell', () => {
    expect(shellScriptOf(['watch', '-n', '1', 'cmd 2>/dev/null'])).toBe('cmd 2>/dev/null');
  });

  it('marks a command lookup instead of a command', () => {
    expect(commandWords(['command', '-v', 'sh', '-c', 'cmd'])).toEqual({
      words: ['sh', '-c', 'cmd'],
      lookup: true,
    });

    expect(commandWords(['command', '-p', '--', 'hc', 'send'])).toEqual({
      words: ['hc', 'send'],
      lookup: false,
    });

    expect(shellScriptOf(['command', '-v', 'sh', '-c', 'cmd'])).toBeUndefined();
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
