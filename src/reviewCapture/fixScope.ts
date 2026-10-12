export interface FixScopeFacts {
  fixPaths: readonly string[];
  findingPaths: readonly string[];
}

export interface FixScope {
  scope: 'fix' | 'wholeTarget';
  outsidePaths: string[];
}

// A fix that touches a file no finding cites needs a review of the whole target.
export const decideFixScope = ({ fixPaths, findingPaths }: FixScopeFacts): FixScope => {
  const cited = new Set(findingPaths);
  const outsidePaths = fixPaths.filter((path) => !cited.has(path));

  return { scope: outsidePaths.length === 0 ? 'fix' : 'wholeTarget', outsidePaths };
};
