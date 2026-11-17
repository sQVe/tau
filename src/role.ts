export type RoleKind = 'worker' | 'lead' | 'architect';

export const roleKind = (environment: Readonly<Record<string, string | undefined>>): RoleKind => {
  const role = environment.TAU_ROLE;

  return role === 'worker' || role === 'architect' ? role : 'lead';
};

export const currentRole = (): RoleKind => {
  // oxlint-disable-next-line node/no-process-env -- The parent sets the role in the pane environment.
  return roleKind(process.env);
};

export const isWorkerProcess = (): boolean => currentRole() === 'worker';
