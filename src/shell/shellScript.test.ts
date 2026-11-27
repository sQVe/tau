import { expect, it } from 'vitest';

import { shellScriptOf } from './shellScript.js';

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
])('reads the -c script past $name', ({ words }) => {
  expect(shellScriptOf(words)).toBe('cmd');
});

it('expands the split string of every leading env wrapper', () => {
  expect(shellScriptOf(['env', '-i', 'env', '-S', 'sh -c cmd'])).toBe('cmd');
  expect(shellScriptOf(['env', 'FOO=1', 'env', '-S', 'sh -c cmd'])).toBe('cmd');
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
])('reads the -c script past $name keyword', ({ keyword }) => {
  expect(shellScriptOf([keyword, 'sh', '-c', 'cmd'])).toBe('cmd');
});

it('reads the -c script past a long shell option that contains c', () => {
  expect(shellScriptOf(['bash', '--rcfile=/tmp/rc', '-c', 'hc send'])).toBe('hc send');
  expect(shellScriptOf(['bash', '--rcfile', '/tmp/rc', 'script.sh'])).toBeUndefined();
  expect(shellScriptOf(['bash', '--rcfile', '/tmp/rc', '-c', 'hc send'])).toBe('hc send');
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
  expect(shellScriptOf(['bash', '-co', 'pipefail', 'cmd 2>/dev/null &'])).toBe('cmd 2>/dev/null &');

  expect(shellScriptOf(['bash', '-cO', 'pipefail', 'cmd'])).toBe('cmd');
});

it('reads the script after an option terminator that never names the script', () => {
  expect(shellScriptOf(['bash', '-co', 'pipefail', '--', 'cmd'])).toBe('cmd');
  expect(shellScriptOf(['bash', '-c', '--', 'cmd'])).toBe('cmd');
  expect(shellScriptOf(['bash', '-c', '--'])).toBeUndefined();
});

it('reads the script after a wrapper operand after an option terminator', () => {
  expect(shellScriptOf(['flock', '--', '-lockfile', 'bash', '-lc', 'cmd'])).toBe('cmd');
});

it('reads a combined flag word that gives its value to -o before -c', () => {
  expect(shellScriptOf(['bash', '-oc', 'cmd'])).toBeUndefined();
  expect(shellScriptOf(['bash', '-lc', 'cmd'])).toBe('cmd');
});

it('reads the script the external time binary runs', () => {
  expect(shellScriptOf(['/usr/bin/time', '-o', '/tmp/log', 'sh', '-c', 'cmd'])).toBe('cmd');
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

it('reads the script flock runs after the lock file and its other options', () => {
  expect(shellScriptOf(['flock', '/tmp/lock', '-w', '5', 'sh', '-c', 'cmd 2>/dev/null'])).toBe(
    'cmd 2>/dev/null',
  );
});

it.each(['constructor', 'toString', '__proto__'])(
  'treats the %s command name as an ordinary command',
  (name) => {
    expect(shellScriptOf([name, '-x'])).toBeUndefined();
  },
);

it('joins the words watch hands to its shell', () => {
  expect(shellScriptOf(['watch', '-n', '1', 'cmd 2>/dev/null'])).toBe('cmd 2>/dev/null');
});

it('reports no script for a command lookup', () => {
  expect(shellScriptOf(['command', '-v', 'sh', '-c', 'cmd'])).toBeUndefined();
});
