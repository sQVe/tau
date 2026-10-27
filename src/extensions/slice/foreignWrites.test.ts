import { describe, expect, it } from 'vitest';

import { decideForeignWrites } from './foreignWrites.js';
import type { ExistingTicket } from './foreignWrites.js';
import type { SliceWrite } from './writes.js';

const tickets: ExistingTicket[] = [
  { identifier: 'ME-1', assignee: 'viewer', creator: null },
  { identifier: 'ME-2', assignee: 'viewer', creator: null },
  { identifier: 'ME-3', assignee: 'other', creator: 'viewer' },
  { identifier: 'ME-4', assignee: null, creator: null },
  { identifier: 'ME-5', assignee: null, creator: 'other' },
  { identifier: 'ME-6', assignee: 'other', creator: null },
  { identifier: 'ME-8', assignee: 'viewer', creator: null },
];

const sliceIdentifiers = ['ME-2', 'ME-3', null, 'ME-4'];

describe('decideForeignWrites', () => {
  it.each([
    {
      case: 'the write creates the container',
      writes: [{ kind: 'createContainer' }],
      foreign: [],
    },
    {
      case: 'the write creates a slice',
      writes: [{ kind: 'createSlice', number: 3, sortOrder: 0 }],
      foreign: [],
    },
    {
      case: "the container is the viewer's",
      writes: [{ kind: 'updateContainer', identifier: 'ME-1', title: true, description: false }],
      foreign: [],
    },
    {
      case: 'the container belongs to another person',
      writes: [{ kind: 'updateContainer', identifier: 'ME-6', title: true, description: false }],
      foreign: ['ME-6'],
    },
    {
      case: "the slice is the viewer's",
      writes: [
        { kind: 'updateSlice', number: 1, identifier: 'ME-2', title: true, description: false },
      ],
      foreign: [],
    },
    {
      case: 'the slice belongs to another person',
      writes: [
        { kind: 'updateSlice', number: 2, identifier: 'ME-3', title: false, description: true },
      ],
      foreign: ['ME-3'],
    },
    {
      case: 'the slice has no assignee and another person created it',
      writes: [
        { kind: 'updateSlice', number: 2, identifier: 'ME-5', title: false, description: true },
      ],
      foreign: ['ME-5'],
    },
    {
      case: 'the slice owner is unknown',
      writes: [
        { kind: 'updateSlice', number: 4, identifier: 'ME-4', title: true, description: false },
      ],
      foreign: ['ME-4'],
    },
    {
      case: 'the slice is missing from the existing tickets',
      writes: [
        { kind: 'updateSlice', number: 1, identifier: 'ME-7', title: true, description: false },
      ],
      foreign: ['ME-7'],
    },
    {
      case: "a move targets the viewer's slice",
      writes: [{ kind: 'moveSlice', identifier: 'ME-2', sortOrder: 5 }],
      foreign: [],
    },
    {
      case: 'a move targets a slice another person owns',
      writes: [{ kind: 'moveSlice', identifier: 'ME-3', sortOrder: 5 }],
      foreign: ['ME-3'],
    },
    {
      case: "a new slice is blocked by the viewer's slice",
      writes: [{ kind: 'addBlockedBy', number: 3, blocker: 1 }],
      foreign: [],
    },
    {
      case: "a new slice is blocked by another person's slice",
      writes: [{ kind: 'addBlockedBy', number: 3, blocker: 2 }],
      foreign: ['ME-3'],
    },
    {
      case: "the viewer's slice is blocked by a new slice",
      writes: [{ kind: 'addBlockedBy', number: 1, blocker: 3 }],
      foreign: [],
    },
    {
      case: "another person's slice is blocked by the viewer's slice",
      writes: [{ kind: 'addBlockedBy', number: 2, blocker: 1 }],
      foreign: ['ME-3'],
    },
    {
      case: "the viewer's slice drops a blocker that another person owns",
      writes: [{ kind: 'removeBlockedBy', identifier: 'ME-2', blocker: 'ME-3' }],
      foreign: ['ME-3'],
    },
    {
      case: "another person's slice drops a blocker that the viewer owns",
      writes: [{ kind: 'removeBlockedBy', identifier: 'ME-3', blocker: 'ME-2' }],
      foreign: ['ME-3'],
    },
    {
      case: 'the viewer drops a blocker the viewer owns',
      writes: [{ kind: 'removeBlockedBy', identifier: 'ME-2', blocker: 'ME-8' }],
      foreign: [],
    },
    {
      case: 'two writes change the same foreign slice',
      writes: [
        { kind: 'updateSlice', number: 2, identifier: 'ME-3', title: true, description: false },
        { kind: 'moveSlice', identifier: 'ME-3', sortOrder: 5 },
      ],
      foreign: ['ME-3'],
    },
    {
      case: "the writes mix the viewer's and another person's slices",
      writes: [
        { kind: 'updateSlice', number: 1, identifier: 'ME-2', title: true, description: false },
        { kind: 'updateSlice', number: 2, identifier: 'ME-3', title: true, description: false },
        { kind: 'moveSlice', identifier: 'ME-4', sortOrder: 5 },
      ],
      foreign: ['ME-3', 'ME-4'],
    },
  ] satisfies { case: string; writes: SliceWrite[]; foreign: string[] }[])(
    'returns $foreign when $case',
    ({ writes, foreign }) => {
      expect(decideForeignWrites('viewer', writes, sliceIdentifiers, tickets)).toEqual(foreign);
    },
  );
});
