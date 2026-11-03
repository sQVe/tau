import { describe, expect, it } from 'vitest';

import {
  assertion,
  rawReport,
  reportOf,
  testFile,
  testFilePath,
  validReport,
} from '../fixtures/reportBuilders.js';
import { assertionFullName, parseReport } from './report.js';
import type { VitestAssertionResult, VitestReport } from './report.js';

interface ParseCase {
  name: string;
  text: string;
  expected: VitestReport | null;
}

interface AssertionNameCase {
  name: string;
  assertion: VitestAssertionResult;
  version: string;
  expected: string;
}

const rawFile = (file: unknown) =>
  JSON.stringify({ numTotalTests: 1, numFailedTests: 0, numPassedTests: 1, testResults: [file] });

describe('parseReport', () => {
  it.each<ParseCase>([
    { name: 'a valid report', text: JSON.stringify(validReport), expected: validReport },
    {
      name: 'an assertion without optional fields',
      text: JSON.stringify(reportOf([testFile([{ status: 'passed' }])])),
      expected: reportOf([testFile([{ status: 'passed' }])]),
    },
    {
      name: 'a null duration',
      text: JSON.stringify(reportOf([testFile([assertion({ duration: null })])])),
      expected: reportOf([testFile([assertion({ duration: null })])]),
    },
    { name: 'text that is not JSON', text: '{', expected: null },
    { name: 'a JSON null', text: 'null', expected: null },
    {
      name: 'a fractional test count',
      text: JSON.stringify({ ...validReport, numTotalTests: 1.5 }),
      expected: null,
    },
    {
      name: 'a negative failure count',
      text: JSON.stringify({ ...validReport, numFailedTests: -1 }),
      expected: null,
    },
    {
      name: 'a non-array testResults value',
      text: JSON.stringify({ ...validReport, testResults: {} }),
      expected: null,
    },
    {
      name: 'a file status other than passed or failed',
      text: JSON.stringify(reportOf([testFile([assertion()], { status: 'skipped' })])),
      expected: null,
    },
    {
      name: 'an assertion status outside the known set',
      text: rawReport({ status: 'bogus' }),
      expected: null,
    },
    {
      name: 'a non-string assertion title',
      text: rawReport({ status: 'passed', title: 7 }),
      expected: null,
    },
    {
      name: 'a string duration',
      text: rawReport({ status: 'passed', duration: '3' }),
      expected: null,
    },
    { name: 'a JSON number', text: '5', expected: null },
    { name: 'a JSON string', text: '"report"', expected: null },
    {
      name: 'only a total test count',
      text: JSON.stringify({ numTotalTests: 1 }),
      expected: null,
    },
    {
      name: 'only a non-array testResults value',
      text: JSON.stringify({ numTotalTests: 1, testResults: {} }),
      expected: null,
    },
    {
      name: 'a missing total count',
      text: JSON.stringify({ numFailedTests: 0, numPassedTests: 1, testResults: [] }),
      expected: null,
    },
    {
      name: 'a missing failed count',
      text: JSON.stringify({ numTotalTests: 1, numPassedTests: 1, testResults: [] }),
      expected: null,
    },
    {
      name: 'a missing passed count',
      text: JSON.stringify({ numTotalTests: 1, numFailedTests: 0, testResults: [] }),
      expected: null,
    },
    {
      name: 'a negative failed count in the adapter shape',
      text: JSON.stringify({
        numTotalTests: 1,
        numFailedTests: -1,
        numPassedTests: 1,
        testResults: [],
      }),
      expected: null,
    },
    {
      name: 'a non-integer passed count in the adapter shape',
      text: JSON.stringify({
        numTotalTests: 1,
        numFailedTests: 0,
        numPassedTests: 0.5,
        testResults: [],
      }),
      expected: null,
    },
    {
      name: 'a non-array assertionResults value',
      text: rawFile({ name: testFilePath, status: 'passed', assertionResults: {} }),
      expected: null,
    },
    {
      name: 'an unknown assertion status in the adapter shape',
      text: rawReport({ status: 'unknown' }),
      expected: null,
    },
    {
      name: 'a non-array ancestorTitles value',
      text: rawReport({ status: 'passed', ancestorTitles: 42 }),
      expected: null,
    },
    {
      name: 'a non-string assertion fullName value',
      text: rawReport({ fullName: 42, status: 'passed' }),
      expected: null,
    },
    {
      name: 'a non-string assertion title value',
      text: rawReport({ title: 42, status: 'passed' }),
      expected: null,
    },
    {
      name: 'a non-array assertion failureMessages value',
      text: rawReport({ status: 'passed', failureMessages: 42 }),
      expected: null,
    },
    {
      name: 'a non-number assertion duration value',
      text: rawReport({ status: 'passed', duration: 'slow' }),
      expected: null,
    },
    {
      name: 'a non-string file name value',
      text: rawFile({ name: 42, status: 'passed', assertionResults: [{ status: 'passed' }] }),
      expected: null,
    },
    {
      name: 'a non-string file message value',
      text: rawFile({
        name: testFilePath,
        status: 'passed',
        message: 42,
        assertionResults: [{ status: 'passed' }],
      }),
      expected: null,
    },
    {
      name: 'an unknown file status in the adapter shape',
      text: rawFile({ name: testFilePath, status: 'unknown', assertionResults: [] }),
      expected: null,
    },
  ])('returns $name', ({ text, expected }) => {
    expect(parseReport(text)).toEqual(expected);
  });
});

describe('assertionFullName', () => {
  it.each<AssertionNameCase>([
    {
      name: 'a Vitest 4 fullName as given',
      assertion: assertion({ fullName: 'outer suite works' }),
      version: '4.1.11',
      expected: 'outer suite works',
    },
    {
      name: 'Vitest 4 titles joined by spaces without fullName',
      assertion: assertion({ ancestorTitles: ['outer', 'inner'], title: 'works' }),
      version: '4.1.11',
      expected: 'outer inner works',
    },
    {
      name: 'Vitest 4 titles with an empty part dropped',
      assertion: assertion({ ancestorTitles: ['outer', ''], title: 'works' }),
      version: '4.1.11',
      expected: 'outer works',
    },
    {
      name: 'Vitest 5 title parts joined by " > " over a space-joined fullName',
      assertion: assertion({
        ancestorTitles: ['outer suite', 'inner'],
        title: 'works',
        fullName: 'outer suite inner works',
      }),
      version: '5.0.1',
      expected: 'outer suite > inner > works',
    },
    {
      name: 'Vitest 5 literal " > " inside a title kept as written',
      assertion: assertion({ ancestorTitles: ['suite'], title: 'a > b' }),
      version: '5.0.1',
      expected: 'suite > a > b',
    },
    {
      name: 'Vitest 5 fullName when no title parts are reported',
      assertion: { status: 'passed', fullName: 'legacy name' },
      version: '5.0.1',
      expected: 'legacy name',
    },
  ])('returns $name', ({ assertion: entry, version, expected }) => {
    expect(assertionFullName(entry, version)).toBe(expected);
  });
});
