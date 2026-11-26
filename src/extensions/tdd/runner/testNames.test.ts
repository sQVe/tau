import { describe, expect, it } from 'vitest';

import { matchesRequestedName, nameSeparator, requestedNamePattern } from './testNames.js';

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
  ])('accepts each registered form of $name', ({ name, registered }) => {
    const pattern = requestedNamePattern([name], nameSeparator('4.1.11'));

    expect(registered.filter((candidate) => !matchesPattern(pattern, candidate))).toEqual([]);
    expect(matchesPattern(pattern, 'other works')).toBe(false);
    expect(matchesPattern(pattern, `${name} again`)).toBe(false);
  });

  it('accepts a wrapped name at every Vitest 5 separator', () => {
    const pattern = requestedNamePattern(['outer > works'], nameSeparator('5.0.1'));

    expect(matchesPattern(pattern, "'outer > works'")).toBe(true);
    expect(matchesPattern(pattern, "outer > 'works'")).toBe(true);
    expect(matchesPattern(pattern, "outer '>' works")).toBe(false);
  });

  it('escapes regular expression characters in the requested name', () => {
    const pattern = requestedNamePattern(['adds (item) [1]'], nameSeparator('4.1.11'));

    expect(matchesPattern(pattern, 'adds (item) [1]')).toBe(true);
    expect(matchesPattern(pattern, 'adds item 1')).toBe(false);
  });

  it('keeps the first segment when the separator is empty', () => {
    const pattern = requestedNamePattern(['works'], '');

    expect(matchesPattern(pattern, 'works')).toBe(true);
    expect(matchesPattern(pattern, "'works'")).toBe(true);
  });

  it('matches no name when none is requested', () => {
    expect(matchesPattern(requestedNamePattern([], nameSeparator('4.1.11')), 'works')).toBe(false);
  });
});
