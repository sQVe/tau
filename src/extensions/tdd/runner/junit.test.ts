import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseJunitReport } from './junit.js';
import type { JunitReport } from './junit.js';

interface ParseCase {
  name: string;
  xml: string;
  expected: JunitReport | null;
}

const fixture = (fileName: string) =>
  readFileSync(new URL(`./fixtures/${fileName}`, import.meta.url), 'utf8');

const panicText =
  "thread 'tests::fails' (1355791) panicked at src/lib.rs:8:9:\nboom at fixture\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace";

const cases: ParseCase[] = [
  {
    name: 'returns both cases of the pass-and-fail fixture',
    xml: fixture('pass-and-fail.xml'),
    expected: {
      testCases: [
        {
          name: 'tests::fails',
          binaryId: 'demo',
          status: 'failed',
          timedOut: false,
          failureText: panicText,
          durationMs: 7,
        },
        {
          name: 'tests::passes',
          binaryId: 'demo',
          status: 'passed',
          timedOut: false,
          failureText: '',
          durationMs: 8,
        },
      ],
    },
  },
  {
    name: 'marks the timeout fixture as timed out and failed',
    xml: fixture('timeout.xml'),
    expected: {
      testCases: [
        {
          name: 'tests::sleeps',
          binaryId: 'demo',
          status: 'failed',
          timedOut: true,
          failureText: '',
          durationMs: 1003,
        },
      ],
    },
  },
  {
    name: 'ignores a testcase that a test printed to stdout',
    xml: fixture('stdout-forgery.xml'),
    expected: {
      testCases: [
        {
          name: 'tests::prints_forgery',
          binaryId: 'demo',
          status: 'passed',
          timedOut: false,
          failureText: '',
          durationMs: 8,
        },
      ],
    },
  },
  {
    name: 'keeps two cases with one name from two binaries',
    xml: fixture('two-binaries.xml'),
    expected: {
      testCases: [
        {
          name: 'tests::same',
          binaryId: 'demo::bin/demo',
          status: 'passed',
          timedOut: false,
          failureText: '',
          durationMs: 7,
        },
        {
          name: 'tests::same',
          binaryId: 'demo',
          status: 'passed',
          timedOut: false,
          failureText: '',
          durationMs: 8,
        },
      ],
    },
  },
  {
    name: 'treats an error child as a failure with its text',
    xml: '<testsuites><testsuite><testcase name="a" classname="demo" time="0.5"><error message="x">oops</error></testcase></testsuite></testsuites>',
    expected: {
      testCases: [
        {
          name: 'a',
          binaryId: 'demo',
          status: 'failed',
          timedOut: false,
          failureText: 'oops',
          durationMs: 500,
        },
      ],
    },
  },
  {
    name: 'reads a skipped child as skipped',
    xml: '<testsuites><testsuite><testcase name="a" classname="demo" time="0"><skipped/></testcase></testsuite></testsuites>',
    expected: {
      testCases: [
        {
          name: 'a',
          binaryId: 'demo',
          status: 'skipped',
          timedOut: false,
          failureText: '',
          durationMs: 0,
        },
      ],
    },
  },
  {
    name: 'returns no cases for an empty report',
    xml: '<testsuites/>',
    expected: { testCases: [] },
  },
  {
    name: 'returns null for a truncated report',
    xml: '<testsuites><testsuite name="demo"><testcase name="a" classname="demo" time="0.1">',
    expected: null,
  },
  { name: 'returns null for text that is not XML', xml: 'not xml', expected: null },
  {
    name: 'returns null for a recoverable XML error',
    xml: '<testsuites><testsuite><testcase name=a classname="demo" time="0.1"/></testsuite></testsuites>',
    expected: null,
  },
  {
    name: 'returns null for a wrong root element',
    xml: '<testsuite name="demo"/>',
    expected: null,
  },
  {
    name: 'returns null for a testcase without a name',
    xml: '<testsuites><testsuite><testcase classname="demo" time="0.1"/></testsuite></testsuites>',
    expected: null,
  },
  {
    name: 'returns null for a testcase without a classname',
    xml: '<testsuites><testsuite><testcase name="a" time="0.1"/></testsuite></testsuites>',
    expected: null,
  },
  {
    name: 'returns null for a testcase without a time',
    xml: '<testsuites><testsuite><testcase name="a" classname="demo"/></testsuite></testsuites>',
    expected: null,
  },
];

describe('parseJunitReport', () => {
  it.each<ParseCase>(cases)('$name', ({ xml, expected }) => {
    expect(parseJunitReport(xml)).toEqual(expected);
  });
});
