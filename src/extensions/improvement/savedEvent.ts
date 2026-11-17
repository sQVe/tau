import { basename } from 'node:path';

import { eventDirectory, readEvents } from '../../improvement/event.js';
import type { ImprovementEvent } from '../../improvement/event.js';

type ReviewEvent = Extract<ImprovementEvent, { kind: 'review' }>;

type ClassEvent = Extract<ImprovementEvent, { kind: 'class' }>;

export function findSavedEvent(
  projectRoot: string,
  id: string,
  kind: 'review',
): Promise<ReviewEvent>;

export function findSavedEvent(projectRoot: string, id: string, kind: 'class'): Promise<ClassEvent>;

export async function findSavedEvent(
  projectRoot: string,
  id: string,
  kind: 'review' | 'class',
): Promise<ReviewEvent | ClassEvent> {
  const directory = eventDirectory(projectRoot);
  const { events, gaps } = await readEvents(projectRoot);
  const gap = gaps.find(({ path }) => basename(path) === `${id}.json`);

  if (gap !== undefined) {
    throw new Error(gap.reason);
  }

  const event = events.find((candidate) => candidate.id === id);

  if (event?.kind !== kind) {
    throw new Error(`No ${kind} event ${id} in ${directory}.`);
  }

  return event;
}
