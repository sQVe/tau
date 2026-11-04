import type { ReportFormat } from './types.js';

export const maximumFailures = 10;

export const reportLabels: Record<ReportFormat, string> = {
  json: 'JSON report',
  junit: 'JUnit report',
};
