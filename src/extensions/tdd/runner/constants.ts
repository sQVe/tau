import type { ReportFormat } from './types.js';

export const maximumFailures = 10;

const maximumMessageCharacters = 300;

export const reportLabels: Record<ReportFormat, string> = {
  json: 'JSON report',
  junit: 'JUnit report',
};

export const capMessage = (text: string): string =>
  text.length > maximumMessageCharacters
    ? `${text.slice(0, maximumMessageCharacters).replace(/[\uD800-\uDBFF]$/, '')}…`
    : text;
