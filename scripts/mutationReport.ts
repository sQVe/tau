export interface MutantLocation {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

export interface Mutant {
  mutatorName: string;
  replacement: string;
  status: string;
  location: MutantLocation;
}

export interface MutationReport {
  files: Record<string, { mutants: Mutant[] }>;
}

const maxSnippetLength = 80;

const unreported = new Set(['Ignored', 'CompileError']);

const squash = (text: string) => {
  const flat = text.replaceAll(/\s+/g, ' ').trim();

  return flat.length > maxSnippetLength ? `${flat.slice(0, maxSnippetLength)}...` : flat;
};

// Stryker counts lines and columns from 1; the end column is exclusive.
const originalText = (source: string, { start, end }: MutantLocation) => {
  const lines = source.split('\n');

  if (start.line === end.line) {
    return (lines[start.line - 1] ?? '').slice(start.column - 1, end.column - 1);
  }

  const first = (lines[start.line - 1] ?? '').slice(start.column - 1);
  const middle = lines.slice(start.line, end.line - 1);
  const last = (lines[end.line - 1] ?? '').slice(0, end.column - 1);

  return [first, ...middle, last].join('\n');
};

const mutantLine = (path: string, mutant: Mutant, source: string) => {
  const original = squash(originalText(source, mutant.location));
  const replacement = squash(mutant.replacement);
  const label = mutant.status === 'NoCoverage' ? ' (no coverage)' : '';

  return `${path}:${mutant.location.start.line} ${mutant.mutatorName}: ${original} -> ${replacement}${label}`;
};

const reportedMutants = (report: MutationReport) =>
  Object.entries(report.files).flatMap(([path, { mutants }]) =>
    mutants
      .filter(({ status }) => status === 'Survived' || status === 'NoCoverage')
      .map((mutant) => ({ path, mutant })),
  );

const byPosition = (
  left: { path: string; mutant: Mutant },
  right: { path: string; mutant: Mutant },
) => {
  if (left.path !== right.path) {
    return left.path < right.path ? -1 : 1;
  }

  const leftStart = left.mutant.location.start;
  const rightStart = right.mutant.location.start;

  return leftStart.line - rightStart.line || leftStart.column - rightStart.column;
};

const totalsLine = (report: MutationReport) => {
  const mutants = Object.values(report.files).flatMap((file) => file.mutants);
  const counted = mutants.filter(({ status }) => !unreported.has(status));
  const count = (status: string) => counted.filter((mutant) => mutant.status === status).length;

  return `${counted.length} mutants: ${count('Killed') + count('Timeout')} killed, ${count('Survived')} survived, ${count('NoCoverage')} no coverage`;
};

// Lists each surviving or uncovered mutant, then a totals line. `sources` maps each path to its text.
export const formatMutationReport = (
  report: MutationReport,
  sources: Record<string, string>,
): string => {
  const lines = reportedMutants(report)
    .toSorted(byPosition)
    .map(({ path, mutant }) => mutantLine(path, mutant, sources[path] ?? ''));

  return [...lines, totalsLine(report)].join('\n');
};
