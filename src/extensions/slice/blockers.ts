// Each entry lists the slice numbers, starting at 1, that block the slice at that index.
type BlockedBy = readonly (readonly number[])[];

const unknownBlockerProblem = (blockedBy: BlockedBy) => {
  for (const [index, blockers] of blockedBy.entries()) {
    const number = index + 1;
    const unknown = blockers.find((blocker) => blocker > blockedBy.length || blocker === number);

    if (unknown !== undefined) {
      return `slice ${number} is blocked by ${unknown}, which is not another slice in the plan.`;
    }
  }

  return undefined;
};

// Apply adds one relation per entry, so a repeated blocker would add the same relation twice.
const repeatedBlockerProblem = (blockedBy: BlockedBy) => {
  for (const [index, blockers] of blockedBy.entries()) {
    const repeated = blockers.find((blocker, position) => blockers.indexOf(blocker) !== position);

    if (repeated !== undefined) {
      return `slice ${index + 1} lists slice ${repeated} more than once in blockedBy.`;
    }
  }

  return undefined;
};

// Follows blockedBy from each slice and returns the slice numbers of the first cycle it finds.
// Expects every blocker to name a slice in the plan.
const findCycle = (blockedBy: BlockedBy): number[] | undefined => {
  const finished = new Set<number>();

  const visit = (number: number, path: number[]): number[] | undefined => {
    const start = path.indexOf(number);

    if (start !== -1) {
      return path.slice(start);
    }

    if (finished.has(number)) {
      return undefined;
    }

    for (const blocker of blockedBy[number - 1] ?? []) {
      const cycle = visit(blocker, [...path, number]);

      if (cycle !== undefined) {
        return cycle;
      }
    }

    finished.add(number);

    return undefined;
  };

  for (const index of blockedBy.keys()) {
    const cycle = visit(index + 1, []);

    if (cycle !== undefined) {
      return cycle;
    }
  }

  return undefined;
};

const cycleProblem = (blockedBy: BlockedBy) => {
  const cycle = findCycle(blockedBy);

  return cycle === undefined
    ? undefined
    : `slices ${cycle.join(', ')} block each other in a cycle.`;
};

// Returns why the slices' blockedBy lists cannot become Linear relations, or undefined when they
// can.
export const blockerProblem = (blockedBy: BlockedBy): string | undefined =>
  unknownBlockerProblem(blockedBy) ?? repeatedBlockerProblem(blockedBy) ?? cycleProblem(blockedBy);
