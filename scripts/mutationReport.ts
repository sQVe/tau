export type MutationMode = 'changed' | 'audit';

export type MutationStatus = 'pass' | 'survivors' | 'nothing' | 'error';

export interface MutantLocation {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

export interface Mutant {
  mutatorName: string;
  replacement: string;
  status: string;
  location: MutantLocation;
  static?: boolean;
  coveredBy?: string[];
  killedBy?: string[];
  testsCompleted?: number;
}

// The part of Stryker's JSON report this module reads.
export interface StrykerReport {
  config?: { ignoreStatic?: boolean };
  files: Record<string, { mutants: Mutant[] }>;
  testFiles?: Record<string, { tests: { id: string; name: string }[] }>;
}

export interface Survivor {
  file: string;
  line: number;
  column: number;
  mutator: string;
  original: string;
  replacement: string;
  covered: boolean;
}

export type Kill = Omit<Survivor, 'covered'>;

export interface TestWithNoUniqueKill {
  file: string;
  test: string;
  kills: Kill[];
}

export interface Totals {
  mutants: number;
  killed: number;
  survived: number;
  noCoverage: number;
  timeout: number;
  invalid: number;
  falseSurvived: number;
}

// A null mode means the command line did not name one.
export interface MutationOutcome {
  version: 1;
  mode: MutationMode | null;
  status: MutationStatus;
  error?: string;
  survivors: Survivor[];
  falseSurvivors: Survivor[];
  unmutated: string[];
  totals: Totals;
  // Present in audit mode only.
  testsWithNoUniqueKill?: TestWithNoUniqueKill[];
}

export interface MutationFacts {
  mode: MutationMode;
  // Undefined when Stryker did not run.
  stryker?: StrykerReport | undefined;
  sources: Record<string, string>;
  unmutated: string[];
  // Set when the run failed before it produced a report.
  error?: string;
}

const maxSnippetLength = 80;

const emptyTotals: Totals = {
  mutants: 0,
  killed: 0,
  survived: 0,
  noCoverage: 0,
  timeout: 0,
  invalid: 0,
  falseSurvived: 0,
};

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

const isSurvivor = ({ status }: Mutant) => status === 'Survived' || status === 'NoCoverage';

const testCountOf = (report: StrykerReport | undefined) =>
  Object.values(report?.testFiles ?? {}).reduce((sum, { tests }) => sum + tests.length, 0);

// With ignoreStatic, Stryker runs a static mutant against only the tests that cover it.
const plannedCountOf = (report: StrykerReport | undefined) => {
  const testCount = testCountOf(report);
  const ignoresStatic = report?.config?.ignoreStatic === true;

  return (mutant: Mutant) => (ignoresStatic ? (mutant.coveredBy?.length ?? 0) : testCount);
};

// A static mutant that makes a test file throw while it loads leaves that file's tests unrun,
// yet Stryker reports it as Survived.
const isFalseSurvivor = (mutant: Mutant, plannedCount: (mutant: Mutant) => number) => {
  const isStaticSurvivor = mutant.static === true && mutant.status === 'Survived';

  return (
    isStaticSurvivor &&
    mutant.testsCompleted !== undefined &&
    mutant.testsCompleted < plannedCount(mutant)
  );
};

const survivorOf = (file: string, mutant: Mutant, source: string): Survivor => ({
  file,
  line: mutant.location.start.line,
  column: mutant.location.start.column,
  mutator: mutant.mutatorName,
  original: squash(originalText(source, mutant.location)),
  replacement: squash(mutant.replacement),
  covered: mutant.status !== 'NoCoverage',
});

const bySurvivorPosition = (left: Kill, right: Kill) => {
  if (left.file !== right.file) {
    return left.file < right.file ? -1 : 1;
  }

  return left.line - right.line || left.column - right.column;
};

const killOf = (file: string, mutant: Mutant, source: string): Kill => {
  const { covered: _covered, ...kill } = survivorOf(file, mutant, source);

  return kill;
};

const byTestPosition = (left: TestWithNoUniqueKill, right: TestWithNoUniqueKill) => {
  if (left.file !== right.file) {
    return left.file < right.file ? -1 : 1;
  }

  if (left.test === right.test) {
    return 0;
  }

  return left.test < right.test ? -1 : 1;
};

// A test has a unique kill when it alone is in the killedBy list of a Killed mutant.
const testsWithNoUniqueKillOf = (
  report: StrykerReport,
  sources: Record<string, string>,
): TestWithNoUniqueKill[] => {
  const killed = Object.entries(report.files).flatMap(([file, { mutants }]) =>
    mutants
      .filter(({ status, killedBy }) => status === 'Killed' && (killedBy?.length ?? 0) > 0)
      .map((mutant) => ({ mutant, kill: killOf(file, mutant, sources[file] ?? '') })),
  );

  const entries = Object.entries(report.testFiles ?? {}).flatMap(([file, { tests }]) =>
    tests.map(({ id, name }) => ({
      file,
      test: name,
      kills: killed
        .filter(({ mutant }) => mutant.killedBy?.includes(id) === true)
        .map(({ kill }) => kill)
        .toSorted(bySurvivorPosition),
      isUnique: killed.some(
        ({ mutant }) => mutant.killedBy?.length === 1 && mutant.killedBy[0] === id,
      ),
    })),
  );

  return entries
    .filter(({ isUnique }) => !isUnique)
    .map(({ file, test, kills }) => ({ file, test, kills }))
    .toSorted(byTestPosition);
};

const totalsOf = (mutants: Mutant[], plannedCount: (mutant: Mutant) => number): Totals => {
  const count = (...statuses: string[]) =>
    mutants.filter(({ status }) => statuses.includes(status)).length;

  const falseSurvived = mutants.filter((mutant) => isFalseSurvivor(mutant, plannedCount)).length;

  return {
    mutants: mutants.filter(({ status }) => status !== 'Ignored').length,
    killed: count('Killed'),
    survived: count('Survived') - falseSurvived,
    noCoverage: count('NoCoverage'),
    timeout: count('Timeout'),
    invalid: count('CompileError', 'RuntimeError'),
    falseSurvived,
  };
};

const auditList = (facts: MutationFacts) =>
  facts.stryker === undefined ? [] : testsWithNoUniqueKillOf(facts.stryker, facts.sources);

const outcome = (
  facts: MutationFacts,
  status: MutationStatus,
  survivors: Survivor[],
  falseSurvivors: Survivor[],
  totals: Totals,
  error?: string,
): MutationOutcome => ({
  version: 1,
  mode: facts.mode,
  status,
  ...(error === undefined ? {} : { error }),
  survivors,
  falseSurvivors,
  unmutated: facts.unmutated,
  totals,
  ...(facts.mode === 'audit' ? { testsWithNoUniqueKill: auditList(facts) } : {}),
});

const unmutatedMessage = (unmutated: string[]) =>
  `${unmutated.length} file(s) were not mutated: the mutant cap left them out, or Stryker selected none of their mutants.`;

const survivorsStatus = (mode: MutationMode) => ({
  status: 'survivors' as const,
  exitCode: mode === 'changed' ? 2 : 0,
});

// Decides the status and exit code from the facts of one run.
export const buildMutationReport = (
  facts: MutationFacts,
): { report: MutationOutcome; exitCode: number } => {
  const plannedCount = plannedCountOf(facts.stryker);
  const files = Object.entries(facts.stryker?.files ?? {});
  const mutants = files.flatMap(([, file]) => file.mutants);
  const totals = facts.stryker === undefined ? emptyTotals : totalsOf(mutants, plannedCount);

  const survivorsWhere = (keep: (mutant: Mutant) => boolean) =>
    files
      .flatMap(([file, { mutants: fileMutants }]) =>
        fileMutants
          .filter((mutant) => isSurvivor(mutant) && keep(mutant))
          .map((mutant) => survivorOf(file, mutant, facts.sources[file] ?? '')),
      )
      .toSorted(bySurvivorPosition);

  const survivors = survivorsWhere((mutant) => !isFalseSurvivor(mutant, plannedCount));
  const falseSurvivors = survivorsWhere((mutant) => isFalseSurvivor(mutant, plannedCount));

  if (facts.error !== undefined) {
    return {
      report: outcome(facts, 'error', survivors, falseSurvivors, totals, facts.error),
      exitCode: 1,
    };
  }

  if (facts.unmutated.length > 0) {
    const error = unmutatedMessage(facts.unmutated);

    return {
      report: outcome(facts, 'error', survivors, falseSurvivors, totals, error),
      exitCode: 1,
    };
  }

  if (totals.mutants === 0) {
    return { report: outcome(facts, 'nothing', survivors, falseSurvivors, totals), exitCode: 0 };
  }

  if (totals.invalid === totals.mutants) {
    const error = 'Every mutant failed to compile or run.';

    return {
      report: outcome(facts, 'error', survivors, falseSurvivors, totals, error),
      exitCode: 1,
    };
  }

  if (survivors.length > 0) {
    const { status, exitCode } = survivorsStatus(facts.mode);

    return { report: outcome(facts, status, survivors, falseSurvivors, totals), exitCode };
  }

  return { report: outcome(facts, 'pass', survivors, falseSurvivors, totals), exitCode: 0 };
};

// A run that failed before it chose a mode or counted mutants.
export const failedMutationReport = (
  mode: MutationMode | null,
  error: string,
): MutationOutcome => ({
  version: 1,
  mode,
  status: 'error',
  error,
  survivors: [],
  falseSurvivors: [],
  unmutated: [],
  totals: emptyTotals,
  ...(mode === 'audit' ? { testsWithNoUniqueKill: [] } : {}),
});
