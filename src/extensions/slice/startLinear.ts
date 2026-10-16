import { Type } from 'typebox';
import { Value } from 'typebox/value';

import type { Exec } from '../../exec.js';
import { api, unexpectedOutput } from '../../linear.js';

interface StartChild {
  identifier: string;
  title: string;
  description: string;
  url: string;
  team: string;
  project: string | null;
  assignee: string | null;
  creator: string | null;
}

export interface StartSlice {
  id: string;
  viewer: string;
  children: StartChild[];
}

const sliceQuery =
  'query($id: String!) { viewer { id } issue(id: $id) { id children(first: 100) { pageInfo { hasNextPage } nodes { identifier title description url team { key } project { name } assignee { id } creator { id } } } } }';

const userSchema = Type.Union([Type.Object({ id: Type.String() }), Type.Null()]);

const sliceSchema = Type.Object({
  viewer: Type.Object({ id: Type.String() }),
  issue: Type.Union([
    Type.Object({
      id: Type.String(),
      children: Type.Object({
        pageInfo: Type.Object({ hasNextPage: Type.Boolean() }),
        nodes: Type.Array(
          Type.Object({
            identifier: Type.String(),
            title: Type.String(),
            description: Type.Union([Type.String(), Type.Null()]),
            url: Type.String(),
            team: Type.Object({ key: Type.String() }),
            project: Type.Union([Type.Object({ name: Type.String() }), Type.Null()]),
            assignee: userSchema,
            creator: userSchema,
          }),
        ),
      }),
    }),
    Type.Null(),
  ]),
});

// Reads every child of the slice, whatever its team or project. Undefined when Linear has no issue
// with that identifier.
export const readStartSlice = async (
  exec: Exec,
  cwd: string,
  identifier: string,
): Promise<StartSlice | undefined> => {
  const response = await api(exec, cwd, sliceQuery, { id: identifier });

  if (!Value.Check(sliceSchema, response.data)) {
    throw unexpectedOutput(response);
  }

  const { issue } = response.data;

  if (issue === null) {
    return undefined;
  }

  // A matching child on a later page would look missing and get created twice.
  if (issue.children.pageInfo.hasNextPage) {
    throw new Error(
      `${identifier} has more children than one Linear page returns, so a same-title child could be missed. Nothing was written.`,
    );
  }

  return {
    id: issue.id,
    viewer: response.data.viewer.id,
    children: issue.children.nodes.map((node) => ({
      identifier: node.identifier,
      title: node.title,
      description: node.description ?? '',
      url: node.url,
      team: node.team.key,
      project: node.project?.name ?? null,
      assignee: node.assignee?.id ?? null,
      creator: node.creator?.id ?? null,
    })),
  };
};
