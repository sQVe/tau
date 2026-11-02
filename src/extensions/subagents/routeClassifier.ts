import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { ConfigLocation } from '../../config/config.js';
import { parseModelReference, readAllowedModels } from '../../config/models.js';
import type { ClassifierOutcome, ModelRoute } from './modelRoutes.js';
import { findTicketPath } from './ticketPath.js';

interface ClassifierState {
  brief: string;
  profile: string;
  cwd: string;
}

export interface Classification {
  outcome: ClassifierOutcome;
  ticketSent: boolean;
}

interface TicketPath {
  path: string;
  slices: string;
}

const classifierTimeoutMilliseconds = 5000;

export const classifierAllowed = (location: ConfigLocation, route: ModelRoute): boolean => {
  const allowed = readAllowedModels(location);

  return allowed === undefined || allowed.models.includes(route.classifier);
};

const ticketCharacterLimit = 12_000;

const maximumBytesPerCharacter = 4;

const ticketByteLimit = ticketCharacterLimit * maximumBytesPerCharacter;

const fillBuffer = async (file: FileHandle, buffer: Buffer, filled: number): Promise<number> => {
  if (filled === buffer.length) {
    return filled;
  }

  const { bytesRead } = await file.read(buffer, filled, buffer.length - filled, filled);

  if (bytesRead === 0) {
    return filled;
  }

  return fillBuffer(file, buffer, filled + bytesRead);
};

const escapesDirectory = (path: string, directory: string): boolean => {
  const relation = relative(directory, path);

  return relation.split(sep)[0] === '..';
};

const isSameFile = (first: BigIntStats, second: BigIntStats): boolean =>
  first.dev === second.dev && first.ino === second.ino;

const readOpenedTicket = async (
  file: FileHandle,
  ticket: TicketPath,
): Promise<string | undefined> => {
  const stats = await file.stat({ bigint: true });

  if (!stats.isFile()) {
    return undefined;
  }

  const realPath = await realpath(ticket.path);
  const realSlices = await realpath(ticket.slices);

  if (escapesDirectory(realPath, realSlices)) {
    return undefined;
  }

  const named = await stat(realPath, { bigint: true });

  if (!isSameFile(stats, named)) {
    return undefined;
  }

  const buffer = Buffer.alloc(ticketByteLimit);
  const filled = await fillBuffer(file, buffer, 0);

  return buffer.toString('utf8', 0, filled).slice(0, ticketCharacterLimit);
};

// The text comes only from the opened descriptor. Its real path, checked after the open, must stay
// inside the slices root and name the same file. This refuses a symlink swapped into a parent
// directory. O_NONBLOCK keeps a named pipe from blocking the open.
const readTicket = async (ticket: TicketPath): Promise<string | undefined> => {
  try {
    const file = await open(ticket.path, constants.O_RDONLY | constants.O_NONBLOCK);

    try {
      return await readOpenedTicket(file, ticket);
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
};

const ticketSlicesMarker = '/.tau/slices/';

const resolveTicketPath = (brief: string, cwd: string): TicketPath | undefined => {
  const written = findTicketPath(brief);

  if (written === undefined) {
    return undefined;
  }

  const path = resolve(cwd, written);
  const markerIndex = path.indexOf(ticketSlicesMarker);

  if (markerIndex === -1) {
    return undefined;
  }

  return { path, slices: path.slice(0, markerIndex + ticketSlicesMarker.length - 1) };
};

export const classifyRoute = async (
  context: Pick<ExtensionContext, 'modelRegistry'>,
  route: ModelRoute,
  { brief, profile, cwd }: ClassifierState,
  launchSignal: AbortSignal | undefined,
): Promise<Classification> => {
  const reference = parseModelReference(route.classifier);

  if (reference === undefined) {
    return { outcome: { kind: 'skipped' }, ticketSent: false };
  }

  const classifier = context.modelRegistry.findOfType(
    'classifier',
    reference.provider,
    reference.id,
  );

  if (classifier === undefined) {
    return { outcome: { kind: 'skipped' }, ticketSent: false };
  }

  const controller = new AbortController();
  const stopped = Promise.withResolvers<ClassifierOutcome>();

  const stop = (outcome: ClassifierOutcome) => {
    controller.abort();
    stopped.resolve(outcome);
  };

  const timer = setTimeout(() => {
    stop({ kind: 'timeout' });
  }, classifierTimeoutMilliseconds);

  const cancel = () => {
    stop({ kind: 'error' });
  };

  launchSignal?.addEventListener('abort', cancel, { once: true });

  try {
    const ticketPath = resolveTicketPath(brief, cwd);
    const reading = ticketPath === undefined ? undefined : readTicket(ticketPath);
    const read = await Promise.race([reading, stopped.promise]);

    if (typeof read === 'object') {
      return { outcome: read, ticketSent: false };
    }

    const state = read === undefined ? { brief, profile } : { brief, ticket: read, profile };

    const answer = context.modelRegistry
      .classify(
        classifier,
        {
          state,
          questions: {
            route: {
              type: 'choice',
              instructions: route.question,
              criteria: Object.fromEntries(
                [...route.labels].map(([label, { criterion }]) => [label, criterion]),
              ),
            },
          },
        },
        { signal: controller.signal },
      )
      .then((result): ClassifierOutcome => {
        const choice = result.answers.route;

        if (result.stopReason !== 'stop' || choice?.type !== 'choice') {
          return { kind: 'error' };
        }

        return { kind: 'answered', label: choice.choice, confidence: choice.confidence };
      })
      .catch((): ClassifierOutcome => ({ kind: 'error' }));

    const outcome = await Promise.race([answer, stopped.promise]);

    return { outcome, ticketSent: read !== undefined };
  } finally {
    clearTimeout(timer);
    launchSignal?.removeEventListener('abort', cancel);
  }
};
