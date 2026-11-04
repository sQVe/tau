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
