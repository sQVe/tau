// Catches only a synchronous throw; a rejected promise escapes it.
export const thrownBy = (action: () => unknown): unknown => {
  try {
    action();
  } catch (error) {
    return error;
  }

  throw new Error('The action did not throw.');
};
