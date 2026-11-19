import { expect, it } from 'vitest';

import { placementLabels } from './workerPlacement.js';

const table: {
  name: string;
  managerLabels: Record<string, string>;
  expected: Record<string, string>;
}[] = [
  {
    name: 'gives an investigation worker the manager space and a workers tab',
    managerLabels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-2' },
    expected: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-2-workers' },
  },
  {
    name: 'gives an editing worker the manager space and the workers tab',
    managerLabels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-2' },
    expected: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-2-workers' },
  },
  {
    name: 'ignores other manager labels',
    managerLabels: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-2', 'tau.profile': 'manager' },
    expected: { 'herdr.space': 'space-1', 'herdr.tab': 'tab-2-workers' },
  },
  {
    name: 'gives no labels when the manager has no space',
    managerLabels: { 'herdr.tab': 'tab-2' },
    expected: {},
  },
  {
    name: 'gives no labels when the manager has no tab',
    managerLabels: { 'herdr.space': 'space-1' },
    expected: {},
  },
  {
    name: 'gives no labels when the manager space is empty',
    managerLabels: { 'herdr.space': '', 'herdr.tab': 'tab-2' },
    expected: {},
  },
  {
    name: 'gives no labels when the manager tab is empty',
    managerLabels: { 'herdr.space': 'space-1', 'herdr.tab': '' },
    expected: {},
  },
  {
    name: 'gives no labels when the manager has no labels',
    managerLabels: {},
    expected: {},
  },
];

it.each(table.map((row) => [row.name, row] as const))(
  '%s',
  (_name, { managerLabels, expected }) => {
    expect(placementLabels(managerLabels)).toStrictEqual(expected);
  },
);
