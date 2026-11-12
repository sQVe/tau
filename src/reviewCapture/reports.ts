export const reportFileNames = ['reviewer.md', 'finder.md', 'checker.md'];

export const hasWorkerReports = (names: string[]): boolean => {
  const hasFinderAndChecker = names.includes('finder.md') && names.includes('checker.md');

  return names.includes('reviewer.md') || hasFinderAndChecker;
};
