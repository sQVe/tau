import { expect, it } from 'vitest';

import { shellScriptOf } from './shellScript.js';

const scriptOf = (words: readonly string[]): string | undefined => {
  const shellScript = shellScriptOf(words);

  return shellScript.kind === 'script' ? shellScript.script : undefined;
};

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
  expect(scriptOf(words)).toBe('cmd');
});

it('expands the split string of every leading env wrapper', () => {
  expect(scriptOf(['env', '-i', 'env', '-S', 'sh -c cmd'])).toBe('cmd');
  expect(scriptOf(['env', 'FOO=1', 'env', '-S', 'sh -c cmd'])).toBe('cmd');
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
  expect(scriptOf([keyword, 'sh', '-c', 'cmd'])).toBe('cmd');
});

it('reads the -c script past a long shell option that contains c', () => {
  expect(scriptOf(['bash', '--rcfile=/tmp/rc', '-c', 'hc send'])).toBe('hc send');
  expect(scriptOf(['bash', '--rcfile', '/tmp/rc', 'script.sh'])).toBeUndefined();
  expect(scriptOf(['bash', '--rcfile', '/tmp/rc', '-c', 'hc send'])).toBe('hc send');
});

it('reads the -c script only before a shell operand', () => {
  expect(scriptOf(['bash', 'script.sh', '-c', 'hc send'])).toBeUndefined();
  expect(scriptOf(['sh', '--', 'script', '-c', 'hc send'])).toBeUndefined();
  expect(scriptOf(['bash', '-x', 'script.sh', '-c', 'hc send'])).toBeUndefined();
  expect(scriptOf(['bash', '-o', 'pipefail', '-c', 'cmd'])).toBe('cmd');
  expect(scriptOf(['bash', '-euo', 'pipefail', '-c', 'cmd'])).toBe('cmd');
  expect(scriptOf(['bash', '--rcfile', '/tmp/rc', '-c', 'cmd'])).toBe('cmd');
  expect(scriptOf(['bash', '-lc', 'cmd'])).toBe('cmd');
});

it('reads the script after a flag word that sets -c and takes a value', () => {
  expect(scriptOf(['bash', '-co', 'pipefail', 'cmd 2>/dev/null &'])).toBe('cmd 2>/dev/null &');

  expect(scriptOf(['bash', '-cO', 'pipefail', 'cmd'])).toBe('cmd');
});

it('reads the script after an option terminator that never names the script', () => {
  expect(scriptOf(['bash', '-co', 'pipefail', '--', 'cmd'])).toBe('cmd');
  expect(scriptOf(['bash', '-c', '--', 'cmd'])).toBe('cmd');
  expect(scriptOf(['bash', '-c', '--'])).toBeUndefined();
});

it('reads the script after a wrapper operand after an option terminator', () => {
  expect(scriptOf(['flock', '--', '-lockfile', 'bash', '-lc', 'cmd'])).toBe('cmd');
});

it('reads a combined flag word that gives its value to -o before -c', () => {
  expect(scriptOf(['bash', '-oc', 'cmd'])).toBeUndefined();
  expect(scriptOf(['bash', '-lc', 'cmd'])).toBe('cmd');
});

it('reads the script the external time binary runs', () => {
  expect(scriptOf(['/usr/bin/time', '-o', '/tmp/log', 'sh', '-c', 'cmd'])).toBe('cmd');
});

it('reads a flock script option before and after the lock file', () => {
  expect(scriptOf(['flock', '-c', 'cmd 2>/dev/null', '/tmp/lock'])).toBe('cmd 2>/dev/null');
  expect(scriptOf(['flock', '/tmp/lock', '-c', 'cmd 2>/dev/null'])).toBe('cmd 2>/dev/null');
});

it('reads a flock script from an inline option value', () => {
  expect(scriptOf(['flock', '--command=cmd 2>/dev/null', '/tmp/lock'])).toBe('cmd 2>/dev/null');
});

it('reads a flock script from a short option cluster', () => {
  expect(scriptOf(['flock', '-xc', 'cmd 2>/dev/null', '/tmp/lock'])).toBe('cmd 2>/dev/null');
  expect(scriptOf(['flock', '-ccmd 2>/dev/null', '/tmp/lock'])).toBe('cmd 2>/dev/null');
});

it('reads a flock script option after the lock file and its other options', () => {
  expect(scriptOf(['flock', '/tmp/lock', '-w', '5', '-c', 'cmd 2>/dev/null'])).toBe(
    'cmd 2>/dev/null',
  );
});

it('reads the script flock runs after the lock file and its other options', () => {
  expect(scriptOf(['flock', '/tmp/lock', '-w', '5', 'sh', '-c', 'cmd 2>/dev/null'])).toBe(
    'cmd 2>/dev/null',
  );
});

it('reads the script after options that follow -c', () => {
  expect(scriptOf(['bash', '-c', '-e', 'git commit -m x'])).toBe('git commit -m x');
  expect(scriptOf(['bash', '-c', '-x', '--', 'cmd'])).toBe('cmd');
  expect(scriptOf(['bash', '-c', '-e'])).toBeUndefined();
});

it('splits an env -S value with env word rules', () => {
  expect(scriptOf(['env', '-S', "FOO='a b' sh -c cmd"])).toBe('cmd');
  expect(scriptOf(['env', '-S', 'FOO="a b" sh -c "hc send t1 x"'])).toBe('hc send t1 x');
  expect(scriptOf(['env', '-iS', "sh -c 'echo x'"])).toBe('echo x');
});

it('reports an env -S value that depends on the environment as unreadable', () => {
  expect(shellScriptOf(['env', '-S', `\${SHELL} -c cmd`])).toEqual({ kind: 'unreadable' });

  expect(shellScriptOf(['env', '-S', `'\${SHELL}' -c cmd`])).toEqual({ kind: 'none' });
});

it('runs nothing for an env -S value that env rejects', () => {
  expect(shellScriptOf(['env', '-S', 'a\\ b sh -c cmd'])).toEqual({ kind: 'none' });
});

it.each(['constructor', 'toString', '__proto__'])(
  'treats the %s command name as an ordinary command',
  (name) => {
    expect(scriptOf([name, '-x'])).toBeUndefined();
  },
);

it('joins the words watch hands to its shell', () => {
  expect(scriptOf(['watch', '-n', '1', 'cmd 2>/dev/null'])).toBe('cmd 2>/dev/null');
});

it('reports no script for a command lookup', () => {
  expect(scriptOf(['command', '-v', 'sh', '-c', 'cmd'])).toBeUndefined();
});

it('runs nothing for a lookup before an unreadable env split value', () => {
  expect(shellScriptOf(['command', '-v', 'env', '-S', `\${SHELL}`])).toEqual({ kind: 'none' });
});
