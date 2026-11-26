import { createRequire } from 'node:module';

interface ReporterAttempt {
  specifier: string;
  reporter: unknown;
  errorCode: string | undefined;
}

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

const attemptJsonReporter = (specifier: string): ReporterAttempt => {
  try {
    const loaded: unknown = projectRequire(specifier);

    return { specifier, reporter: jsonReporterIn(loaded), errorCode: undefined };
  } catch (error) {
    return { specifier, reporter: undefined, errorCode: errorCodeOf(error) };
  }
};

const loadJsonReporter = (): unknown => {
  const attempts = reporterSpecifiers.map(attemptJsonReporter);
  const found = attempts.find((attempt) => attempt.reporter !== undefined);

  if (found !== undefined) {
    return found.reporter;
  }

  const details = attempts.map(
    ({ specifier, errorCode }) => `${specifier}: ${errorCode ?? 'no JSON reporter export'}`,
  );

  throw new Error(
    `Tau's Vitest report reporter found no JSON reporter in the Vitest installed for ${process.cwd()} (${details.join('; ')}). Reinstall Vitest for this project.`,
  );
};

export default loadJsonReporter();
