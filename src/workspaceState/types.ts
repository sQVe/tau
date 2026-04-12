import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

export interface WorkspaceNamespace<T extends Record<string, unknown> = Record<string, unknown>> {
  get(): Promise<T>;
  set(value: T): Promise<void>;
  patch(partial: Partial<T> | ((current: T) => Partial<T>)): Promise<void>;
}

export interface WorkspaceState {
  namespace<T extends Record<string, unknown> = Record<string, unknown>>(
    name: string,
  ): WorkspaceNamespace<T>;
}

export const workspaceStateVersion = 1 as const;

export const workspaceStateNamespaceValueSchema = Type.Record(Type.String(), Type.Unknown());

export const workspaceStateEnvelopeSchema = Type.Object({
  version: Type.Literal(workspaceStateVersion),
  namespaces: Type.Record(Type.String(), workspaceStateNamespaceValueSchema),
});

export type WorkspaceStateNamespaceValue = Static<typeof workspaceStateNamespaceValueSchema>;
export type WorkspaceStateEnvelope = Static<typeof workspaceStateEnvelopeSchema>;
