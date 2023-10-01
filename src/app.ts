import { createYoga, type Plugin } from 'graphql-yoga';
import { schema, type Context } from './schema.js';
import { Db } from './db.js';
import { createLoaders } from './loaders.js';
import { viewerFromHeader } from './auth.js';
import { depthLimit } from './depth-limit.js';

/** Adds `extensions.dbQueries` to every response, so the effect of batching is visible in GraphiQL. */
const queryCounter = (db: Db): Plugin => ({
  onExecute() {
    const before = db.queries;
    return {
      onExecuteDone({ result, setResult }) {
        if (!('data' in result)) return;
        setResult({ ...result, extensions: { ...result.extensions, dbQueries: db.queries - before } });
      },
    };
  },
});

const depthLimitPlugin: Plugin = {
  onValidate: ({ addValidationRule }) => addValidationRule(depthLimit(6)),
};

export function createApp(db = new Db()) {
  const yoga = createYoga<object, Context>({
    schema,
    context: async ({ request }) => ({
      db,
      loaders: createLoaders(db),
      viewer: await viewerFromHeader(request.headers.get('authorization')),
    }),
    plugins: [
      queryCounter(db),
      depthLimitPlugin,
    ],
    maskedErrors: true, // unexpected errors return a generic message; GraphQLErrors pass through
    graphiql: { title: 'Banking GraphQL Gateway' },
  });
  return { yoga, db };
}
