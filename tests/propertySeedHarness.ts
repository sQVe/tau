const fixedSeed = 15;

export const resolvePropertySeed = (): number => {
  const value = process.env.TAU_PROPERTY_SEED;

  if (value === undefined) {
    return fixedSeed;
  }

  if (value === 'random') {
    return Math.floor(Math.random() * 2 ** 31);
  }

  const seed = Number(value);

  if (!Number.isInteger(seed)) {
    throw new TypeError(`TAU_PROPERTY_SEED must be an integer or random, got ${value}`);
  }

  return seed;
};
