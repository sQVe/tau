export const reportFileNames = ['reviewer.md', 'finder.md', 'checker.md'];

// A review has worker reports when one reviewer wrote it, or when a finder and a checker both did.
export const hasWorkerReports = (names: string[]): boolean => {
  const hasFinderAndChecker = names.includes('finder.md') && names.includes('checker.md');

  return names.includes('reviewer.md') || hasFinderAndChecker;
};
