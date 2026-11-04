import type { RouteComparisonReport, SideReport } from './routeComparisonReport.ts';

const percentScale = 100;

const percent = (value: number) => `${Math.round(value * percentScale)}%`;

const launchLines = (side: SideReport) =>
  side.launches.map((launch) => {
    const time = new Date(launch.createdAt).toISOString();

    return `    ${launch.id}  ${launch.model ?? 'unknown'}  ${time}  ${launch.cwd ?? ''}`;
  });

const sideLines = (label: string, side: SideReport, list: boolean) => {
  const marker = side.underTwenty ? ' (under 20, small sample)' : '';

  const models =
    side.models.length === 0
      ? 'none'
      : side.models.map((model) => `${model.model} ${model.launches}`).join(', ');

  const median = side.firstReport.medianMinutes;

  const lines = [`${label}: ${side.launchCount} launches${marker}`, `  models: ${models}`];

  if (list) {
    lines.push('  launches:');
    lines.push(...launchLines(side));
  }

  lines.push(
    `  time to first report: median ${median === undefined ? 'none' : median.toFixed(1)} min (${side.firstReport.measured} measured, ${side.firstReport.missing} without a readable report)`,
    `  follow-ups: mean ${side.followUps.mean.toFixed(2)} per launch, ${percent(side.followUps.share)} of launches have one`,
    `  reviewer findings (approximate): ${side.reviews.withLinkedReview} launches with a linked review, ${side.reviews.withoutReport} reviews without a report, ${side.reviews.share === undefined ? 'none' : percent(side.reviews.share)} with findings`,
    `  success: ${side.success.success} success, ${side.success.failure} failure, ${side.success.incomplete} incomplete, ${side.success.withoutReport} no report (${percent(side.success.share)} success)`,
    '',
  );

  return lines;
};

export const formatRouteComparisonReport = (
  report: RouteComparisonReport,
  list: boolean,
): string => {
  const { profile, label, switch: switchTime, model } = report.options;
  const modelLines = model === undefined ? [] : [`After-side model filter: ${model}`];

  return [
    `Route comparison for ${profile} with label ${label}`,
    `Switch at ${new Date(switchTime).toISOString()}`,
    ...modelLines,
    '',
    ...sideLines('Before switch', report.before, list),
    ...sideLines('After switch', report.after, list),
    `Skipped ${report.skipped} records with no version or an unknown version, ${report.preRouting} pre-routing records, and ${report.duplicateIds} duplicate ids.`,
    '',
  ].join('\n');
};
