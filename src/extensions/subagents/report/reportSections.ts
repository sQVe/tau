export const decisionsSectionName = 'Decisions';

export const handoverSectionNames = [
  'Changes',
  'Evidence',
  decisionsSectionName,
  'Concerns',
] as const;

export const summaryHasHeading = (summary: string, name: string): boolean =>
  new RegExp(`^[\\s#*>-]*${name}\\**\\s*(?::|\\(|$)`, 'im').test(summary);
