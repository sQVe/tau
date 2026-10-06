export interface Placement {
  team: string;
  project: string | null;
  parent: string | null;
}

type PlacementField = keyof Placement;

export interface CandidateFit {
  fits: boolean;
  differences: PlacementField[];
}

const placementFields: PlacementField[] = ['team', 'project', 'parent'];

export const decideCandidateFit = (planned: Placement, candidate: Placement): CandidateFit => {
  const differences = placementFields.filter((field) => planned[field] !== candidate[field]);

  return { fits: differences.length === 0, differences };
};

// An agent ticket goes to the agent team under a parent from another route, so its parent's route
// is not compared and the result is null.
export const decideParentMatchesRoute = (facts: {
  agentTicket: boolean;
  route: { team: string; project: string | null };
  parent: { team: string; project: string | null };
}): boolean | null => {
  if (facts.agentTicket) {
    return null;
  }

  const sameTeam = facts.parent.team === facts.route.team;
  const sameProject = facts.parent.project === facts.route.project;

  return sameTeam && sameProject;
};
