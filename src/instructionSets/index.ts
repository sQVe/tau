import { readFile } from 'node:fs/promises';

export const instructionSetNames = ['writing', 'coding', 'workflow'] as const;

export type InstructionSetName = (typeof instructionSetNames)[number];

export const isInstructionSetName = (name: string): name is InstructionSetName =>
  (instructionSetNames as readonly string[]).includes(name);

export const readInstructionSet = async (name: InstructionSetName): Promise<string> => {
  const path = new URL(`../extensions/${name}/instructions.md`, import.meta.url);
  const instructions = await readFile(path, 'utf8');

  const trimmedInstructions = instructions.trim();

  if (!trimmedInstructions) {
    throw new Error(`The ${name} instructions are empty: ${path.href}`);
  }

  return trimmedInstructions;
};
