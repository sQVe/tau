import { expect, it } from 'vitest';

import type { PiStartTarget } from '../../piStart/piStart.js';
import { startPlacement } from './placement.js';
import type { StartPlacement, StartPlacementFacts } from './placement.js';

type Expected =
  | { kind: 'launch'; target: PiStartTarget }
  | { kind: 'refuse'; mentions: readonly string[] };

const listedSpace = (id: string, name: string, folder: string, machine: string | null = null) => ({
  id,
  name,
  folder,
  machine,
});

const table: { name: string; facts: StartPlacementFacts; expected: Expected }[] = [
  {
    name: 'reuses the space the caller names',
    facts: {
      folder: '/work/repo',
      spaces: [listedSpace('sp-1', 'platform', '/work/repo')],
      space: 'sp-9',
      newSpace: false,
      title: 'next step',
    },
    expected: { kind: 'launch', target: { space: 'sp-9' } },
  },
  {
    name: 'refuses a space together with newSpace',
    facts: {
      folder: '/work/repo',
      spaces: [],
      space: 'sp-9',
      newSpace: true,
      title: 'next step',
    },
    expected: { kind: 'refuse', mentions: [] },
  },
  {
    name: 'refuses one space in the start folder',
    facts: {
      folder: '/work/repo',
      spaces: [listedSpace('sp-1', 'platform', '/work/repo')],
      space: undefined,
      newSpace: false,
      title: 'next step',
    },
    expected: { kind: 'refuse', mentions: ['sp-1', 'platform'] },
  },
  {
    name: 'refuses two spaces in the start folder and names both',
    facts: {
      folder: '/work/repo',
      spaces: [
        listedSpace('sp-1', 'platform', '/work/repo'),
        listedSpace('sp-2', 'second', '/work/repo'),
      ],
      space: undefined,
      newSpace: false,
      title: 'next step',
    },
    expected: { kind: 'refuse', mentions: ['sp-1', 'platform', 'sp-2', 'second'] },
  },
  {
    name: 'creates when only another folder has a space',
    facts: {
      folder: '/work/repo',
      spaces: [listedSpace('sp-1', 'platform', '/work/other')],
      space: undefined,
      newSpace: false,
      title: 'next step',
    },
    expected: { kind: 'launch', target: { name: 'next step' } },
  },
  {
    name: 'creates when the only space with the same folder is on another machine',
    facts: {
      folder: '/work/repo',
      spaces: [listedSpace('sp-1', 'platform', '/work/repo', 'build-2')],
      space: undefined,
      newSpace: false,
      title: 'next step',
    },
    expected: { kind: 'launch', target: { name: 'next step' } },
  },
  {
    name: 'creates when a space folder is a prefix of the start folder',
    facts: {
      folder: '/work/repo',
      spaces: [listedSpace('sp-1', 'platform', '/work')],
      space: undefined,
      newSpace: false,
      title: 'next step',
    },
    expected: { kind: 'launch', target: { name: 'next step' } },
  },
  {
    name: 'creates when no space is listed',
    facts: {
      folder: '/work/repo',
      spaces: [],
      space: undefined,
      newSpace: false,
      title: 'next step',
    },
    expected: { kind: 'launch', target: { name: 'next step' } },
  },
  {
    name: 'creates with newSpace even when the folder has spaces',
    facts: {
      folder: '/work/repo',
      spaces: [listedSpace('sp-1', 'platform', '/work/repo')],
      space: undefined,
      newSpace: true,
      title: 'next step',
    },
    expected: { kind: 'launch', target: { name: 'next step' } },
  },
];

const outcomeOf = (placement: StartPlacement, expected: Expected) => {
  if (expected.kind !== 'refuse') {
    return placement;
  }

  const message = placement.kind === 'refuse' ? placement.message : '';
  const missing = expected.mentions.filter((mention) => !message.includes(mention));

  return { kind: placement.kind, missing };
};

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, { facts, expected }) => {
  const outcome = outcomeOf(startPlacement(facts), expected);
  const wanted = expected.kind === 'refuse' ? { kind: 'refuse', missing: [] } : expected;

  expect(outcome).toEqual(wanted);
});
