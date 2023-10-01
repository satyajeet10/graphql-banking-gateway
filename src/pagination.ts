import { createGraphQLError } from 'graphql-yoga';

export const MAX_PAGE_SIZE = 50;

const encode = (offset: number) => Buffer.from(`cursor:${offset}`).toString('base64url');
function decode(cursor: string): number {
  const raw = Buffer.from(cursor, 'base64url').toString();
  const n = Number(raw.replace('cursor:', ''));
  if (!raw.startsWith('cursor:') || !Number.isInteger(n) || n < 0) {
    throw createGraphQLError('Invalid cursor', { extensions: { code: 'BAD_USER_INPUT' } });
  }
  return n;
}

/** Relay-style cursor connection over an ordered list. Opaque cursors let the backing store change later. */
export function connection<T>(items: T[], args: { first?: number | null; after?: string | null }) {
  const first = args.first ?? 10;
  if (first < 1 || first > MAX_PAGE_SIZE) {
    throw createGraphQLError(`"first" must be between 1 and ${MAX_PAGE_SIZE}`, { extensions: { code: 'BAD_USER_INPUT' } });
  }
  const start = args.after ? decode(args.after) + 1 : 0;
  const slice = items.slice(start, start + first);
  return {
    totalCount: items.length,
    edges: slice.map((node, i) => ({ node, cursor: encode(start + i) })),
    pageInfo: {
      hasNextPage: start + first < items.length,
      endCursor: slice.length ? encode(start + slice.length - 1) : null,
    },
  };
}
