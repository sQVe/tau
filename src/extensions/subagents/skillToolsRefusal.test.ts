import { expect, it } from 'vitest';

import { skillToolsRefusal } from './skillToolsRefusal.js';

const loaded = "export const skillTools = { tdd: ['full_check'] };\n";

it.each([
  { case: 'unchanged', current: loaded, refused: false },
  {
    case: 'a tool added',
    current: "export const skillTools = { tdd: ['full_check', 'mutation_check'] };\n",
    refused: true,
  },
  { case: 'only formatting changed', current: loaded.trimEnd(), refused: true },
  { case: 'emptied', current: '', refused: true },
])('refuses a launch when skillTools on disk is $case: $refused', ({ current, refused }) => {
  expect(skillToolsRefusal(loaded, current) !== undefined).toBe(refused);
});
