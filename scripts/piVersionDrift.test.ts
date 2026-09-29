import { expect, it } from 'vitest';

import { installedPiPath, piVersionDrift } from './piVersionDrift.js';

it.each([
  {
    rule: 'same minor, different patch',
    installed: '0.87.3\n',
    dependency: '0.87.1',
    drift: false,
  },
  { rule: 'same version', installed: '0.87.1', dependency: '0.87.1', drift: false },
  { rule: 'newer installed minor', installed: '0.88.0', dependency: '0.87.1', drift: true },
  { rule: 'older installed minor', installed: '0.86.1', dependency: '0.87.1', drift: true },
  { rule: 'different major', installed: '1.87.1', dependency: '0.87.1', drift: true },
  { rule: 'unparsable output', installed: 'pi: not ready', dependency: '0.87.1', drift: true },
])('$rule', ({ installed, dependency, drift }) => {
  expect(piVersionDrift(installed, dependency) !== undefined).toBe(drift);
});

it.each([
  {
    rule: 'drops the package bin directories pnpm adds',
    path: '/repo/node_modules/.bin:/repo/node_modules/.pnpm/node_modules/.bin:/usr/bin',
    installedPath: '/usr/bin',
  },
  {
    rule: 'keeps a PATH without package bins',
    path: '/opt/pi:/usr/bin',
    installedPath: '/opt/pi:/usr/bin',
  },
  {
    rule: 'drops a trailing-slash package bin',
    path: '/repo/node_modules/.bin/:/usr/bin',
    installedPath: '/usr/bin',
  },
])('$rule', ({ path, installedPath }) => {
  expect(installedPiPath(path, ':')).toBe(installedPath);
});
