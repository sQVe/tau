export const modelRefusal = (profile: string, model: string | undefined): string | undefined => {
  if (model === undefined) {
    return undefined;
  }

  if (profile === 'reviewer' || profile === 'checker') {
    return undefined;
  }

  return `Profile ${profile} cannot set model. Only reviewer and checker launches may set model. Omit model; the profiles block in the user tau.json sets this profile's model.`;
};
