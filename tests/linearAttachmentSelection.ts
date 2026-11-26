export interface AttachmentFields {
  metadata: boolean;
}

const attachmentSelection =
  /attachments\([^)]*\)\s*\{\s*pageInfo\s*\{[^}]*\}\s*nodes\s*\{([^}]*)\}/gu;

// GraphQL returns only the fields a query selects, so a fake follows each attachment selection in
// the query.
export const attachmentSelections = (query: string): AttachmentFields[] =>
  [...query.matchAll(attachmentSelection)].map((match) => ({
    metadata: match[1]!.includes('metadata'),
  }));
