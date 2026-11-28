import { impurities } from './pureModuleImpurities.js';

export const purityProblems = (
  modules: readonly string[],
  exceptions: Readonly<Record<string, readonly string[]>>,
  readSource: (path: string) => string,
): string[] => {
  const problems = modules.flatMap((path) => {
    const findings = impurities(path, readSource(path), modules);
    const reasons = exceptions[path];

    if (reasons === undefined) {
      return findings;
    }

    const remaining = [...findings];
    const unmatched: string[] = [];

    for (const reason of reasons) {
      const matches = remaining.filter((finding) => finding.endsWith(`: ${reason}`));
      const [match] = matches;

      if (match === undefined) {
        unmatched.push(`${path}: unused exception ${reason}`);

        continue;
      }

      if (matches.length > 1) {
        unmatched.push(`${path}: exception ${reason} matches ${matches.length} findings`);

        continue;
      }

      remaining.splice(remaining.indexOf(match), 1);
    }

    return [...remaining, ...unmatched];
  });

  const unregistered = Object.keys(exceptions)
    .filter((path) => !modules.includes(path))
    .map((path) => `${path}: exception for an unregistered module`);

  return [...problems, ...unregistered];
};
