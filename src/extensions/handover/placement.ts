import type { HerdrSpace } from '../../piStart/herdrPane.js';
import type { PiStartTarget } from '../../piStart/piStart.js';

export type SpaceChoice =
  | { kind: 'reuse'; space: string }
  | { kind: 'create' }
  | { kind: 'decide' };

// Both folder values are real paths where the folder can be read, so a symlinked path to one
// checkout matches it.
export interface StartPlacementFacts {
  folder: string;
  spaces: readonly HerdrSpace[];
  spaceChoice: SpaceChoice;
  title: string;
}

export type StartPlacement =
  | { kind: 'launch'; target: PiStartTarget }
  | { kind: 'refuse'; message: string };

const describeSpace = (space: HerdrSpace): string => `${space.id} "${space.name}"`;

const folderRefusal = (spaces: readonly HerdrSpace[]): string => {
  const listed = spaces.map(describeSpace).join(', ');

  return `folder already has a space: ${listed}. Pass space to reuse it, or newSpace: true to create another.`;
};

export const startPlacement = (facts: StartPlacementFacts): StartPlacement => {
  if (facts.spaceChoice.kind === 'reuse') {
    return { kind: 'launch', target: { space: facts.spaceChoice.space } };
  }

  if (facts.spaceChoice.kind === 'create') {
    return { kind: 'launch', target: { name: facts.title } };
  }

  const matching = facts.spaces.filter(
    (space) => space.machine === null && space.folder === facts.folder,
  );

  if (matching.length > 0) {
    return { kind: 'refuse', message: folderRefusal(matching) };
  }

  return { kind: 'launch', target: { name: facts.title } };
};
