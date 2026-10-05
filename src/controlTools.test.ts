import { expect, it } from 'vitest';

import { isNestedControlCall } from './controlTools.js';

const controlTools = [
  'subagent_report',
  'subagent_question',
  'subagent_progress',
  'ask_user_question',
  'subagent',
  'subagent_follow_up',
  'subagent_reply',
  'subagent_cancel',
];

it.each([
  ...controlTools.flatMap((toolName) => [
    { toolName, parentToolCallId: undefined, nested: false },
    { toolName, parentToolCallId: 'codemode-call', nested: true },
  ]),
  { toolName: 'read', parentToolCallId: 'codemode-call', nested: false },
  { toolName: 'subagent_status', parentToolCallId: 'codemode-call', nested: false },
  { toolName: 'subagent_history', parentToolCallId: 'codemode-call', nested: false },
])(
  'decides $toolName with parent $parentToolCallId is nested control: $nested',
  ({ toolName, parentToolCallId, nested }) => {
    const call = parentToolCallId === undefined ? { toolName } : { toolName, parentToolCallId };

    expect(isNestedControlCall(call)).toBe(nested);
  },
);
