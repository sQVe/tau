import { createRequire } from 'node:module';

// The project's own Vitest loads this file, so a bare import resolves from the project root and
// fails wherever the project's release moved or removed the entry that exports the JSON reporter.
// Vitest 4.0 exports it from "vitest/reporters"; 4.1 and 5 export it from "vitest/node".
const reporterSpecifiers = ['vitest/node', 'vitest/reporters'];

const projectRequire = createRequire(`${process.cwd()}/`);

const jsonReporterFrom = (specifier: string): unknown => {
  try {
    const loaded: unknown = projectRequire(specifier);

    if (loaded === null || typeof loaded !== 'object' || !('JsonReporter' in loaded)) {
      return undefined;
    }

    return typeof loaded.JsonReporter === 'function' ? loaded.JsonReporter : undefined;
  } catch {
    return undefined;
  }
};

const loadJsonReporter = (): unknown => {
  for (const specifier of reporterSpecifiers) {
    const reporter = jsonReporterFrom(specifier);

    if (reporter !== undefined) {
      return reporter;
    }
  }

  throw new Error(
    `Tau's Vitest report reporter found no JSON reporter in the Vitest installed for ${process.cwd()}. Reinstall Vitest for this project.`,
  );
};

export default loadJsonReporter();
