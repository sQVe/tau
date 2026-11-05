import { DOMParser } from '@xmldom/xmldom';
import type { Element, Node } from '@xmldom/xmldom';

type JunitStatus = 'passed' | 'failed' | 'skipped';

interface JunitTestCase {
  name: string;
  binaryId: string;
  status: JunitStatus;
  timedOut: boolean;
  failureText: string;
  durationMs: number;
}

export interface JunitReport {
  testCases: JunitTestCase[];
}

const millisecondsPerSecond = 1000;
const rootName = 'testsuites';
const suiteName = 'testsuite';
const caseName = 'testcase';
const timeoutFailureType = 'test timeout';
const decimalSeconds = /^\d+(?:\.\d+)?$/;

const parseRoot = (xml: string): Element | null => {
  const parserProblems: string[] = [];

  const parser = new DOMParser({
    onError: (_level, message) => {
      parserProblems.push(message);
    },
  });

  try {
    const root = parser.parseFromString(xml, 'text/xml').documentElement;

    return parserProblems.length === 0 ? root : null;
  } catch {
    return null;
  }
};

const childElements = (parent: Node, tagName: string): Element[] =>
  Array.from(parent.childNodes).filter(
    (node): node is Element => 'tagName' in node && node.tagName === tagName,
  );

const statusOf = (problem: Element | undefined, skipped: boolean): JunitStatus => {
  if (problem !== undefined) {
    return 'failed';
  }

  return skipped ? 'skipped' : 'passed';
};

const parseTestCase = (element: Element): JunitTestCase | undefined => {
  const name = element.getAttribute('name') ?? '';
  const binaryId = element.getAttribute('classname') ?? '';
  const time = element.getAttribute('time') ?? '';

  if (name === '' || binaryId === '' || !decimalSeconds.test(time)) {
    return undefined;
  }

  const failure = childElements(element, 'failure')[0];
  const problem = failure ?? childElements(element, 'error')[0];
  const skipped = childElements(element, 'skipped').length > 0;

  return {
    name,
    binaryId,
    status: statusOf(problem, skipped),
    timedOut: failure?.getAttribute('type') === timeoutFailureType,
    failureText: problem?.textContent ?? '',
    durationMs: Math.round(Number(time) * millisecondsPerSecond),
  };
};

export const parseJunitReport = (xml: string): JunitReport | null => {
  const root = parseRoot(xml);

  if (root === null || root.tagName !== rootName) {
    return null;
  }

  const testCases: JunitTestCase[] = [];

  for (const suite of childElements(root, suiteName)) {
    for (const element of childElements(suite, caseName)) {
      const testCase = parseTestCase(element);

      if (testCase === undefined) {
        return null;
      }

      testCases.push(testCase);
    }
  }

  return { testCases };
};
