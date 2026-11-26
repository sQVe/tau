import { describe, expect, it } from 'vitest';

import { matchesRequestedName, requestedNamePattern } from './testNames.js';

describe('matchesRequestedName', () => {
  it.for([
    { name: 'a plain name', registered: 'works', requested: 'works', matches: true },
    {
      name: 'a decision-table name wrapped in single quotes',
      registered: "'a declared record accepts'",
      requested: 'a declared record accepts',
      matches: true,
    },
    {
      name: 'a decision-table name wrapped in double quotes',
      registered: '"a declared record accepts"',
      requested: 'a declared record accepts',
      matches: true,
    },
    {
      name: 'a decision-table name under a suite',
      registered: "outer 'a declared record accepts'",
      requested: 'outer a declared record accepts',
      matches: true,
    },
    {
      name: 'a decision-table name under a Vitest 5 suite',
      registered: "outer > inner > 'a declared record accepts'",
      requested: 'outer > inner > a declared record accepts',
      matches: true,
    },
    {
      name: 'the name Vitest registers',
      registered: "'a declared record accepts'",
      requested: "'a declared record accepts'",
      matches: true,
    },
    {
      name: 'another name',
      registered: "'a declared record refuses'",
      requested: 'a declared record accepts',
      matches: false,
    },
    {
      name: 'a plain name with an embedded quote',
      registered: "it's",
      requested: 'its',
      matches: false,
    },
  ])('$name matches $matches', ({ registered, requested, matches }) => {
    expect(matchesRequestedName(registered, requested)).toBe(matches);
  });

  // Chai's rendering leaves no marker that separates a table value from a quoted token.
  it('accepts a title that quotes its last token, as a chai-rendered name', () => {
    expect(matchesRequestedName("returns 'ok'", 'returns ok')).toBe(true);
  });
});

const matchesPattern = (pattern: string, name: string) => new RegExp(pattern).test(name);

describe('requestedNamePattern', () => {
  it.for([
    { name: 'works', registered: ['works', "'works'", '"works"'] },
    {
      name: 'outer works',
      registered: [
        'outer works',
        "'outer works'",
        '"outer works"',
        "outer 'works'",
        'outer "works"',
      ],
    },
    {
      name: 'outer > handles works',
      registered: ['outer > handles works', "outer > handles 'works'", "outer > 'handles works'"],
    },
  ])('accepts each registered form of $name', ({ name, registered }) => {
    const pattern = requestedNamePattern([name]);

    expect(registered.filter((candidate) => !matchesPattern(pattern, candidate))).toEqual([]);
    expect(matchesPattern(pattern, 'other works')).toBe(false);
    expect(matchesPattern(pattern, `${name} again`)).toBe(false);
  });

  it('rejects a quoted separator', () => {
    const pattern = requestedNamePattern(['outer > works']);

    expect(matchesPattern(pattern, "outer '>' works")).toBe(false);
  });

  it('escapes regular expression characters in the requested name', () => {
    const pattern = requestedNamePattern(['adds (item) [1]']);

    expect(matchesPattern(pattern, 'adds (item) [1]')).toBe(true);
    expect(matchesPattern(pattern, 'adds item 1')).toBe(false);
  });

  it('matches no name when none is requested', () => {
    expect(matchesPattern(requestedNamePattern([]), 'works')).toBe(false);
  });
});
