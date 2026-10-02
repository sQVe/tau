import { expect, it } from 'vitest';

import { insertSnippetBody } from './insertion.js';

it.each([
  {
    case: 'a query alone on its line',
    lines: ['#pu'],
    query: { line: 0, start: 0, end: 3 },
    body: 'Push back.',
    result: { lines: ['Push back.'], cursorLine: 0, cursorCol: 10 },
  },
  {
    case: 'a query after text',
    lines: ['Ship it #pu'],
    query: { line: 0, start: 8, end: 11 },
    body: 'Push back.',
    result: { lines: ['Ship it', '', 'Push back.'], cursorLine: 2, cursorCol: 10 },
  },
  {
    case: 'a query before text',
    lines: ['#pu ship it.'],
    query: { line: 0, start: 0, end: 3 },
    body: 'Push back.',
    result: { lines: ['Push back.', '', 'ship it.'], cursorLine: 0, cursorCol: 10 },
  },
  {
    case: 'a query mid-line',
    lines: ['Ship #pu now.'],
    query: { line: 0, start: 5, end: 8 },
    body: 'Push back.',
    result: { lines: ['Ship', '', 'Push back.', '', 'now.'], cursorLine: 2, cursorCol: 10 },
  },
  {
    case: 'a multi-line body between other lines',
    lines: ['First.', '#pu', 'Last.'],
    query: { line: 1, start: 0, end: 3 },
    body: 'Push back.\n\nThen agree.',
    result: {
      lines: ['First.', 'Push back.', '', 'Then agree.', 'Last.'],
      cursorLine: 3,
      cursorCol: 11,
    },
  },
  {
    case: 'a body with indented lines',
    lines: ['  #co'],
    query: { line: 0, start: 2, end: 5 },
    body: 'Run:\n    pnpm check\n\tdone',
    result: { lines: ['Run:', '    pnpm check', '\tdone'], cursorLine: 2, cursorCol: 5 },
  },
  {
    case: 'a bare # after an opening bracket',
    lines: ['Read (#'],
    query: { line: 0, start: 6, end: 7 },
    body: 'Push back.',
    result: { lines: ['Read (', '', 'Push back.'], cursorLine: 2, cursorCol: 10 },
  },
])('inserts the body for $case', ({ lines, query, body, result }) => {
  expect(insertSnippetBody(lines, query, body)).toEqual(result);
});
