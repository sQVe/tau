import { createRequire } from 'node:module';

type ReporterAttempt =
  | { specifier: string; kind: 'found'; reporter: unknown }
  | { specifier: string; kind: 'missing' }
  | { specifier: string; kind: 'failed'; errorCode: string | undefined };

type LoadModule = (specifier: string) => unknown;

// The project's own Vitest loads this file, so a bare import resolves from the project root and
// fails wherever the project's release moved or removed the entry that exports the JSON reporter.
// Vitest 4.0 exports it from "vitest/reporters"; 4.1 and 5 export it from "vitest/node".
const reporterSpecifiers = ['vitest/node', 'vitest/reporters'];

const projectRequire = createRequire(`${process.cwd()}/`);

// Never copy error.message: a resolution error can quote credentials. The code names the failure.
const errorCodeOf = (error: unknown): string | undefined => {
  const code =
    error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;

  return typeof code === 'string' ? code : undefined;
};

const jsonReporterIn = (loaded: unknown): unknown => {
  if (loaded === null || typeof loaded !== 'object' || !('JsonReporter' in loaded)) {
    return undefined;
  }

  return typeof loaded.JsonReporter === 'function' ? loaded.JsonReporter : undefined;
};

const attemptJsonReporter = (load: LoadModule, specifier: string): ReporterAttempt => {
  try {
    const reporter = jsonReporterIn(load(specifier));

    return reporter === undefined
      ? { specifier, kind: 'missing' }
      : { specifier, kind: 'found', reporter };
  } catch (error) {
    return { specifier, kind: 'failed', errorCode: errorCodeOf(error) };
  }
};

const failureDetail = (attempt: ReporterAttempt): string => {
  if (attempt.kind === 'missing') {
    return `${attempt.specifier}: no JSON reporter export`;
  }

  if (attempt.kind === 'failed') {
    return `${attempt.specifier}: load failed (${attempt.errorCode ?? 'no error code'})`;
  }

  return attempt.specifier;
};

export const loadJsonReporter = (load: LoadModule): unknown => {
  const attempts: ReporterAttempt[] = [];

  for (const specifier of reporterSpecifiers) {
    const attempt = attemptJsonReporter(load, specifier);

    attempts.push(attempt);

    if (attempt.kind === 'found') {
      return attempt.reporter;
    }
  }

  const details = attempts.map(failureDetail);

  throw new Error(
    `Tau's Vitest report reporter found no JSON reporter in the Vitest installed for ${process.cwd()} (${details.join('; ')}). Reinstall Vitest for this project.`,
  );
};

export default loadJsonReporter(projectRequire);
