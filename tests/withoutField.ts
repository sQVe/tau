export const withoutField = (
  value: Record<string, unknown>,
  field: string,
): Record<string, unknown> => {
  const kept = Object.entries(value).filter(([name]) => name !== field);

  return Object.fromEntries(kept);
};
