import { expect, it } from 'vitest';

import { herdrAppSpace } from '../../../tests/herdrAppFake.js';
import type { PiStartTarget } from '../../piStart/piStart.js';
import { startPlacement } from './placement.js';
import type { StartPlacementFacts } from './placement.js';

type Expected = { kind: 'launch'; target: PiStartTarget } | { kind: 'refuse'; message: string };

const folderRefusal = (listed: string): string =>
  `folder already has a space: ${listed}. Pass space to reuse it, or newSpace: true to create another.`;

const table: { name: string; facts: StartPlacementFacts; expected: Expected }[] = [
  {
    name: 'reuses the space the caller names',
    facts: {
      folder: '/work/repo',
      spaces: [herdrAppSpace('sp-1', 'platform', '/work/repo')],
      spaceChoice: { kind: 'reuse', space: 'sp-1' },
      title: 'next step',
    },
    expected: { kind: 'launch', target: { space: 'sp-1' } },
  },
  {
    name: 'reuses the space the caller names when it is not listed',
    facts: {
      folder: '/work/repo',
      spaces: [herdrAppSpace('sp-1', 'platform', '/work/repo')],
      spaceChoice: { kind: 'reuse', space: 'sp-9' },
      title: 'next step',
    },
    expected: { kind: 'launch', target: { space: 'sp-9' } },
  },
  {
    name: 'refuses one space in the start folder',
    facts: {
      folder: '/work/repo',
      spaces: [herdrAppSpace('sp-1', 'platform', '/work/repo')],
      spaceChoice: { kind: 'decide' },
      title: 'next step',
    },
    expected: { kind: 'refuse', message: folderRefusal('sp-1 "platform"') },
  },
  {
    name: 'refuses two spaces in the start folder and names both',
    facts: {
      folder: '/work/repo',
      spaces: [
        herdrAppSpace('sp-1', 'platform', '/work/repo'),
        herdrAppSpace('sp-2', 'second', '/work/repo'),
      ],
      spaceChoice: { kind: 'decide' },
      title: 'next step',
    },
    expected: { kind: 'refuse', message: folderRefusal('sp-1 "platform", sp-2 "second"') },
  },
  {
    name: 'creates when only another folder has a space',
    facts: {
      folder: '/work/repo',
      spaces: [herdrAppSpace('sp-1', 'platform', '/work/other')],
      spaceChoice: { kind: 'decide' },
      title: 'next step',
    },
    expected: { kind: 'launch', target: { name: 'next step' } },
  },
  {
    name: 'creates when the only space with the same folder is on another machine',
    facts: {
      folder: '/work/repo',
      spaces: [herdrAppSpace('sp-1', 'platform', '/work/repo', 'build-2')],
      spaceChoice: { kind: 'decide' },
      title: 'next step',
    },
    expected: { kind: 'launch', target: { name: 'next step' } },
  },
  {
    name: 'creates when a space folder is a prefix of the start folder',
    facts: {
      folder: '/work/repo',
      spaces: [herdrAppSpace('sp-1', 'platform', '/work')],
      spaceChoice: { kind: 'decide' },
      title: 'next step',
    },
    expected: { kind: 'launch', target: { name: 'next step' } },
  },
  {
    name: 'creates when no space is listed',
    facts: {
      folder: '/work/repo',
      spaces: [],
      spaceChoice: { kind: 'decide' },
      title: 'next step',
    },
    expected: { kind: 'launch', target: { name: 'next step' } },
  },
  {
    name: 'creates when the caller asks for a new space even when the folder has one',
    facts: {
      folder: '/work/repo',
      spaces: [herdrAppSpace('sp-1', 'platform', '/work/repo')],
      spaceChoice: { kind: 'create' },
      title: 'next step',
    },
    expected: { kind: 'launch', target: { name: 'next step' } },
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, { facts, expected }) => {
  expect(startPlacement(facts)).toEqual(expected);
});
