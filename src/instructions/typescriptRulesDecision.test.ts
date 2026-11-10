import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { classifyTypeScriptActivation, typeScriptToolDecision } from './typescriptRulesDecision.js';

it.for([
  { tool: 'read', path: 'src/main.ts', loaded: false, expected: 'activate' },
  { tool: 'read', path: 'view.tsx', loaded: false, expected: 'activate' },
  { tool: 'read', path: 'module.mts', loaded: false, expected: 'activate' },
  { tool: 'read', path: 'module.cts', loaded: false, expected: 'activate' },
  { tool: 'write', path: 'main.ts', loaded: false, expected: 'block' },
  { tool: 'edit', path: 'main.ts', loaded: false, expected: 'block' },
  { tool: 'write', path: 'main.ts', loaded: true, expected: 'activate' },
  { tool: 'edit', path: 'main.ts', loaded: true, expected: 'activate' },
  { tool: 'read', path: 'main.ts', loaded: true, expected: 'activate' },
  { tool: 'read', path: 'node_modules/package/main.ts', loaded: false, expected: 'ignore' },
  { tool: 'read', path: '/repo/node_modules/main.ts', loaded: false, expected: 'ignore' },
  { tool: 'read', path: 'C:\\repo\\node_modules\\main.ts', loaded: false, expected: 'ignore' },
  { tool: 'read', path: 'node_modules-extra/main.ts', loaded: false, expected: 'activate' },
  { tool: 'read', path: 'main.d.ts', loaded: false, expected: 'ignore' },
  { tool: 'read', path: 'main.d.mts', loaded: false, expected: 'ignore' },
  { tool: 'read', path: 'main.d.cts', loaded: false, expected: 'ignore' },
  { tool: 'read', path: 'main.d.ts.source.ts', loaded: false, expected: 'activate' },
  { tool: 'read', path: 'main.js', loaded: false, expected: 'ignore' },
  { tool: 'read', path: 'ts', loaded: false, expected: 'ignore' },
  { tool: 'read', path: 'main.ts.txt', loaded: false, expected: 'ignore' },
  { tool: 'bash', path: 'main.ts', loaded: false, expected: 'ignore' },
  { tool: 'read', path: undefined, loaded: false, expected: 'ignore' },
  { tool: 'read', path: 42, loaded: false, expected: 'ignore' },
])('decides $tool $path with rules loaded $loaded', ({ tool, path, loaded, expected }) => {
  expect(typeScriptToolDecision(tool, path, loaded)).toBe(expected);
});

const activationFixture = (name: string): unknown => {
  const path = new URL(`./fixtures/typescriptActivation/${name}.json`, import.meta.url);

  return JSON.parse(readFileSync(path, 'utf8'));
};

const activationEntry = (data: unknown) => ({
  type: 'custom',
  customType: 'tau-typescript-rules',
  data,
});

it.for([
  { name: 'missing', entries: [], active: false, unreadable: [] },
  { name: 'null entry', entries: [null], active: false, unreadable: [] },
  { name: 'primitive entry', entries: ['activation'], active: false, unreadable: [] },
  {
    name: 'primitive data',
    entries: [activationEntry('activation')],
    active: false,
    unreadable: [{ kind: 'malformed' }],
  },
  {
    name: 'current after malformed and newer entries',
    entries: [
      activationFixture('malformed'),
      activationFixture('newer'),
      activationFixture('current'),
    ],
    active: true,
    unreadable: [{ kind: 'malformed' }, { kind: 'newer', version: 2 }],
  },
  {
    name: 'current before unreadable entries',
    entries: [
      activationFixture('current'),
      activationFixture('newer'),
      activationFixture('malformed'),
    ],
    active: true,
    unreadable: [{ kind: 'newer', version: 2 }, { kind: 'malformed' }],
  },
  { name: 'current', entries: [activationFixture('current')], active: true, unreadable: [] },
  {
    name: 'newer',
    entries: [activationFixture('newer')],
    active: false,
    unreadable: [{ kind: 'newer', version: 2 }],
  },
  {
    name: 'newer schema',
    entries: [activationEntry({ version: 3, extra: true })],
    active: false,
    unreadable: [{ kind: 'newer', version: 3 }],
  },
  {
    name: 'malformed',
    entries: [activationFixture('malformed')],
    active: false,
    unreadable: [{ kind: 'malformed' }],
  },
  {
    name: 'missing data',
    entries: [{ type: 'custom', customType: 'tau-typescript-rules' }],
    active: false,
    unreadable: [{ kind: 'malformed' }],
  },
  {
    name: 'null data',
    entries: [activationEntry(null)],
    active: false,
    unreadable: [{ kind: 'malformed' }],
  },
  {
    name: 'missing version',
    entries: [activationEntry({})],
    active: false,
    unreadable: [{ kind: 'malformed' }],
  },
  {
    name: 'noninteger version',
    entries: [activationEntry({ version: 2.5 })],
    active: false,
    unreadable: [{ kind: 'malformed' }],
  },
  {
    name: 'infinite version',
    entries: [activationEntry({ version: Infinity })],
    active: false,
    unreadable: [{ kind: 'malformed' }],
  },
  {
    name: 'zero version',
    entries: [activationEntry({ version: 0 })],
    active: false,
    unreadable: [{ kind: 'malformed' }],
  },
  {
    name: 'extra fields',
    entries: [activationEntry({ version: 1, extra: true })],
    active: false,
    unreadable: [{ kind: 'malformed' }],
  },
  {
    name: 'other entry',
    entries: [{ type: 'custom', customType: 'other', data: { version: 1 } }],
    active: false,
    unreadable: [],
  },
  {
    name: 'message',
    entries: [{ type: 'message', customType: 'tau-typescript-rules', data: { version: 1 } }],
    active: false,
    unreadable: [],
  },
])('rebuilds activation from $name evidence', ({ entries, active, unreadable }) => {
  expect(classifyTypeScriptActivation(entries)).toEqual({ active, unreadable });
});
