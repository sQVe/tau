import { expect, it } from 'vitest';

import type { Loadout } from './types.js';
import { placementLabels } from './workerPlacement.js';

const table: {
  name: string;
  role: Loadout['role'];
  managerLabels: Record<string, string>;
  expected: Record<string, string>;
}[] = [
  {
    name: 'gives an investigation worker the manager space and a workers tab',
    role: 'investigation',
    managerLabels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-2' },
    expected: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-2-workers' },
  },
  {
    name: 'gives an editing worker the manager space and tab',
    role: 'editing',
    managerLabels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-2' },
    expected: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-2' },
  },
  {
    name: 'ignores other manager labels',
    role: 'editing',
    managerLabels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-2', 'tau.profile': 'manager' },
    expected: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-2' },
  },
  {
    name: 'gives no labels when the manager has no space',
    role: 'editing',
    managerLabels: { 'herdr.tab': 'tab-2' },
    expected: {},
  },
  {
    name: 'gives no labels when the manager has no tab',
    role: 'investigation',
    managerLabels: { 'herdr.space': 'space-1' },
    expected: {},
  },
  {
    name: 'gives no labels when the manager space is empty',
    role: 'editing',
    managerLabels: { 'herdr.space': '', 'herdr.tab': 'tab-2' },
    expected: {},
  },
  {
    name: 'gives no labels when the manager tab is empty',
    role: 'investigation',
    managerLabels: { 'herdr.space': 'space-1', 'herdr.tab': '' },
    expected: {},
  },
  {
    name: 'gives no labels when the manager has no labels',
    role: 'editing',
    managerLabels: {},
    expected: {},
  },
];

it.each(table.map((row) => [row.name, row] as const))(
  '%s',
  (_name, { role, managerLabels, expected }) => {
    expect(placementLabels(role, managerLabels)).toStrictEqual(expected);
  },
);
