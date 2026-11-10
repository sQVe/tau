import type { TestScope } from './types.js';

export interface FileRoleFacts {
  testMatch: boolean;
  productionMatch: boolean;
  testFilesCanBeProduction: boolean;
}

export interface FileRoles {
  test: boolean;
  production: boolean;
}

export const fileRoles = ({
  testMatch,
  productionMatch,
  testFilesCanBeProduction,
}: FileRoleFacts): FileRoles => {
  const productionRoleAllowed = testFilesCanBeProduction || !testMatch;

  return { test: testMatch, production: productionMatch && productionRoleAllowed };
};

export const acceptsFileRole = (
  scope: TestScope,
  roles: FileRoles & { support: boolean },
): boolean => {
  if (roles.test) {
    return true;
  }

  if (scope !== 'affected') {
    return false;
  }

  return roles.production || roles.support;
};
