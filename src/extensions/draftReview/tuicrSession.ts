import { Type } from 'typebox';
import { Value } from 'typebox/value';

import type { SessionComment } from './reviewDecisions.js';

export type RunTuicr = (argumentsList: string[]) => Promise<string>;

const sessionListSchema = Type.Array(Type.Object({ path: Type.String({ minLength: 1 }) }));

const commentListSchema = Type.Array(
  Type.Object({
    id: Type.String({ minLength: 1 }),
    path: Type.Union([Type.String(), Type.Null()]),
    start_line: Type.Union([Type.Number(), Type.Null()]),
    end_line: Type.Union([Type.Number(), Type.Null()]),
    comment_type: Type.String(),
    content: Type.String(),
  }),
);

const excerptLength = 200;

const parseJson = (command: string, output: string): unknown => {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(
      `${command} printed output that is not JSON: ${output.slice(0, excerptLength)}`,
    );
  }
};

// tuicr stores a file-mode session under the opened directory, so the directory finds the session.
export const listSessionPaths = async (run: RunTuicr, directory: string): Promise<string[]> => {
  const output = await run(['review', 'list', '--repo', directory]);
  const parsed = parseJson('tuicr review list', output);

  if (!Value.Check(sessionListSchema, parsed)) {
    throw new Error(
      `tuicr review list printed an unexpected session list: ${output.slice(0, excerptLength)}`,
    );
  }

  return parsed.map((session) => session.path);
};

export const readSessionComments = async (
  run: RunTuicr,
  sessionPath: string,
): Promise<SessionComment[]> => {
  const output = await run(['review', 'comments', '--session', sessionPath]);
  const parsed = parseJson('tuicr review comments', output);

  if (!Value.Check(commentListSchema, parsed)) {
    throw new Error(
      `tuicr review comments printed unexpected comments: ${output.slice(0, excerptLength)}`,
    );
  }

  return parsed.map((comment) => ({
    id: comment.id,
    path: comment.path,
    startLine: comment.start_line,
    endLine: comment.end_line,
    type: comment.comment_type,
    content: comment.content,
  }));
};

export const deleteSessionComment = async (
  run: RunTuicr,
  sessionPath: string,
  commentId: string,
): Promise<void> => {
  await run(['review', 'delete', '--session', sessionPath, '--comment-id', commentId]);
};
