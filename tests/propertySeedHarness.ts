const fixedSeed = 15;

const seedFrom = (value: string | undefined): number => {
  if (value === undefined) {
    return fixedSeed;
  }

  if (value.trim() === '') {
    throw new TypeError('TAU_PROPERTY_SEED must be an integer or random, got an empty value');
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

export const resolvePropertySeed = (): number => {
  const seed = seedFrom(process.env.TAU_PROPERTY_SEED);

  process.stdout.write(`TAU_PROPERTY_SEED=${seed}\n`);

  return seed;
};
