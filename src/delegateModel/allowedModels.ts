export interface AllowedModelsLayer {
  source: string;
  models: string[] | undefined;
}

export interface AllowedModels {
  models: string[];
  // Each file that set the list, the user file before the repository file.
  sources: string[];
}

// A later layer can only remove models from the list before it, so a repository never grants a
// model the user did not allow. Unlike TDD fields, the lists intersect instead of replacing.
export const effectiveAllowedModels = (layers: AllowedModelsLayer[]): AllowedModels | undefined => {
  let allowed: AllowedModels | undefined;

  for (const { source, models } of layers) {
    if (models === undefined) {
      continue;
    }

    const earlier = allowed;
    const added = earlier ? models.filter((model) => !earlier.models.includes(model)) : [];

    if (earlier && added.length > 0) {
      throw new Error(
        `${source} adds ${added.join(', ')} to allowedModels, but ${earlier.sources.join(' and ')} allows only ${earlier.models.join(', ') || 'no models'}. A repository list can only remove models from the user list.`,
      );
    }

    allowed = { models, sources: [...(earlier?.sources ?? []), source] };
  }

  return allowed;
};
