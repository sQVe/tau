import { expect, it } from 'vitest';

import { adrIndexMark } from './adrIndexMark.js';

const adr = (...fields: string[]) => `# ADR 0001: First\n\n${fields.join('\\\n')}\n\n## Context\n`;
const date = '**Date**: 2026-01-01';
const second = '[ADR 0002 (Second)](./0002-second.md)';
const third = '[ADR 0003 (Third)](./0003-third.md)';
const fourth = '[ADR 0004 (Fourth)](./0004-fourth.md)';

it.each([
  { case: 'an accepted ADR', markdown: adr(date, '**Status**: Accepted'), expected: { mark: '' } },
  {
    case: 'an accepted ADR with Related and Supersedes lines',
    markdown: adr(
      date,
      '**Status**: Accepted',
      `**Supersedes**: ${second}`,
      `**Related**: ${third}`,
    ),
    expected: { mark: '' },
  },
  {
    case: 'a superseded ADR',
    markdown: adr(date, '**Status**: Superseded', `**Superseded by**: ${second}`),
    expected: { mark: ', superseded by 0002' },
  },
  {
    case: 'a superseded ADR that a Related line follows',
    markdown: adr(
      date,
      '**Status**: Superseded',
      `**Superseded by**: ${second} and ${third}`,
      `**Related**: ${fourth}`,
    ),
    expected: { mark: ', superseded by 0002 and 0003' },
  },
  {
    case: 'a partly superseded ADR with a wrapped status',
    markdown: adr(date, `**Status**: Accepted; the rules superseded by\n${second}`),
    expected: { mark: ', partly superseded by 0002' },
  },
  {
    case: 'a partly superseded ADR with a reference link',
    markdown: adr(date, '**Status**: Accepted; the rules superseded by [ADR\n0002][adr-0002]'),
    expected: { mark: ', partly superseded by 0002' },
  },
  {
    case: 'three ADRs named once each',
    markdown: adr(
      date,
      `**Status**: Accepted; one part superseded by ${second}, another by ${third}, and the rest by ${fourth} and ${second}`,
    ),
    expected: { mark: ', partly superseded by 0002, 0003, and 0004' },
  },
  {
    case: 'an ADR without a Status line',
    markdown: adr(date),
    expected: 'problem',
  },
  {
    case: 'a misspelled status',
    markdown: adr(date, '**Status**: Acepted'),
    expected: 'problem',
  },
  {
    case: 'a Proposed status',
    markdown: adr(date, '**Status**: Proposed'),
    expected: 'problem',
  },
  {
    case: 'a superseded ADR without a Superseded by line',
    markdown: adr(date, '**Status**: Superseded'),
    expected: 'problem',
  },
  {
    case: 'a partly superseded status that names no ADR',
    markdown: adr(date, '**Status**: Accepted; the rules were dropped'),
    expected: 'problem',
  },
])('marks $case', ({ markdown, expected }) => {
  const result = adrIndexMark(markdown);
  const outcome = 'problem' in result ? 'problem' : result;

  expect(outcome).toEqual(expected);
});
