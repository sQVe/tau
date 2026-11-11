import type { HealthRule, ToolCall } from './sessionHealthReport.ts';

// A day needs this many results before a share of them can fail a rule.
const minimumResults = 3;
// The first full UTC day run_tests offered the affected scope.
const affectedScopeStart = '2026-11-11';
// A day of test-first work this busy runs affected tests at least once.
const minimumFocusedRuns = 20;

const field = (record: Record<string, unknown> | undefined, name: string) => record?.[name];

const isSummaryLengthRefusal = (call: ToolCall) =>
  call.error?.includes('over the limit of') === true && call.error.includes('summary');

// Add one entry per rule. A check returns why the rule fails for one day's calls of its tool, or
// undefined when the rule holds.
export const healthRules: HealthRule[] = [
  {
    tool: 'run_tests',
    name: 'freshness-known',
    check: (calls) => {
      const freshness = calls.map((call) => field(call.details, 'freshness')).filter(Boolean);
      const unknown = freshness.filter((value) => value === 'unknown').length;

      if (freshness.length < minimumResults || unknown * 2 <= freshness.length) {
        return undefined;
      }

      return `${unknown} of ${freshness.length} results report freshness unknown`;
    },
  },
  {
    tool: 'run_tests',
    name: 'affected-scope-used',
    check: (calls, day) => {
      const scopes = calls.map((call) => field(call.arguments, 'scope'));
      const focused = scopes.filter((scope) => scope === 'focused').length;

      if (day < affectedScopeStart || focused < minimumFocusedRuns || scopes.includes('affected')) {
        return undefined;
      }

      return `${focused} focused runs and no affected run`;
    },
  },
  {
    tool: 'subagent_report',
    name: 'summary-length-accepted',
    check: (calls) => {
      const refused = calls.filter(isSummaryLengthRefusal).length;

      return refused === 0
        ? undefined
        : `${refused} of ${calls.length} reports refused for summary length`;
    },
  },
];
