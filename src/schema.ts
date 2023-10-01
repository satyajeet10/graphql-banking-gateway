// createGraphQLError (not `new GraphQLError`) so Yoga recognises expected errors and doesn't mask them.
import { createGraphQLError, createSchema } from 'graphql-yoga';
import type { Account, Customer, Db, Transaction } from './db.js';
import type { Loaders } from './loaders.js';
import type { Viewer } from './auth.js';
import { connection } from './pagination.js';

export interface Context {
  db: Db;
  loaders: Loaders;
  viewer: Viewer | null;
}

const typeDefs = /* GraphQL */ `
  type Query {
    "The signed-in customer."
    me: Customer!
    "Admins only."
    customer(id: ID!): Customer
    "Admins only. Cursor-paginated."
    customers(first: Int = 10, after: String): CustomerConnection!
  }

  type Mutation {
    "Move money between two of your own accounts. Safe to retry with the same idempotencyKey."
    transfer(input: TransferInput!): TransferPayload!
  }

  type Customer {
    id: ID!
    name: String!
    "Visible only to the customer themself and to admins."
    email: String
    accounts: [Account!]!
  }

  enum AccountType { SAVINGS CURRENT }

  type Account {
    id: ID!
    type: AccountType!
    balance: Money!
    owner: Customer!
    transactions(first: Int = 10, after: String, filter: TransactionFilter): TransactionConnection!
  }

  type Transaction {
    id: ID!
    date: String!
    description: String!
    amount: Money!
    category: String!
  }

  type Money {
    amount: Float!
    currency: String!
    formatted: String!
  }

  input TransactionFilter { from: String, to: String }

  input TransferInput {
    fromAccountId: ID!
    toAccountId: ID!
    amount: Float!
    idempotencyKey: String!
  }

  type TransferPayload {
    transferId: String
    from: Account
    to: Account
    "True when this response replays an earlier request with the same idempotencyKey."
    replayed: Boolean!
    "Expected business failures are data, not exceptions."
    userErrors: [UserError!]!
  }

  type UserError { field: String, message: String! }

  type PageInfo { hasNextPage: Boolean!, endCursor: String }
  type CustomerEdge { node: Customer!, cursor: String! }
  type CustomerConnection { edges: [CustomerEdge!]!, pageInfo: PageInfo!, totalCount: Int! }
  type TransactionEdge { node: Transaction!, cursor: String! }
  type TransactionConnection { edges: [TransactionEdge!]!, pageInfo: PageInfo!, totalCount: Int! }
`;

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
const money = (amount: number) => ({ amount, currency: 'INR', formatted: inr.format(amount) });

function requireViewer(ctx: Context): Viewer {
  if (!ctx.viewer) throw createGraphQLError('Sign in required', { extensions: { code: 'UNAUTHENTICATED' } });
  return ctx.viewer;
}
function requireAdmin(ctx: Context): Viewer {
  const viewer = requireViewer(ctx);
  if (viewer.role !== 'ADMIN') throw createGraphQLError('Admins only', { extensions: { code: 'FORBIDDEN' } });
  return viewer;
}
/** Object-level authorization: customers see only their own accounts; admins see all. */
function assertCanSeeAccount(ctx: Context, account: Account) {
  const viewer = requireViewer(ctx);
  if (viewer.role !== 'ADMIN' && account.customerId !== viewer.id) {
    throw createGraphQLError('Not your account', { extensions: { code: 'FORBIDDEN' } });
  }
}

const resolvers = {
  Query: {
    me: async (_: unknown, __: unknown, ctx: Context) => {
      const viewer = requireViewer(ctx);
      const me = await ctx.loaders.customer.load(viewer.id);
      if (!me) throw createGraphQLError('Customer not found', { extensions: { code: 'UNAUTHENTICATED' } });
      return me;
    },
    customer: async (_: unknown, args: { id: string }, ctx: Context) => {
      requireAdmin(ctx);
      return (await ctx.loaders.customer.load(args.id)) ?? null;
    },
    customers: (_: unknown, args: { first?: number; after?: string }, ctx: Context) => {
      requireAdmin(ctx);
      const all = ctx.db.listCustomers();
      all.forEach((c) => ctx.loaders.customer.prime(c.id, c)); // later .load(id) calls hit the cache
      return connection(all, args);
    },
  },

  Mutation: {
    transfer: async (
      _: unknown,
      { input }: { input: { fromAccountId: string; toAccountId: string; amount: number; idempotencyKey: string } },
      ctx: Context,
    ) => {
      const viewer = requireViewer(ctx);
      const fail = (field: string, message: string) => ({ replayed: false, userErrors: [{ field, message }] });

      if (input.idempotencyKey.length < 8) return fail('idempotencyKey', 'Use a unique key of at least 8 characters.');
      if (!(input.amount > 0)) return fail('amount', 'Amount must be greater than zero.');
      if (input.fromAccountId === input.toAccountId) return fail('toAccountId', 'Choose a different destination account.');

      const [from, to] = await ctx.loaders.account.loadMany([input.fromAccountId, input.toAccountId]);
      const owns = (a: unknown): a is Account => !!a && !(a instanceof Error) && (a as Account).customerId === viewer.id;
      if (!owns(from)) return fail('fromAccountId', 'Account not found.'); // don't reveal others' accounts exist
      if (!owns(to)) return fail('toAccountId', 'Account not found.');
      if (from.balance < input.amount) return fail('amount', `Insufficient funds: ${inr.format(from.balance)} available.`);

      const { replayed, result } = ctx.db.transfer(input);
      return { ...(result as object), replayed, userErrors: [] };
    },
  },

  Customer: {
    email: (c: Customer, _: unknown, ctx: Context) =>
      ctx.viewer && (ctx.viewer.role === 'ADMIN' || ctx.viewer.id === c.id) ? c.email : null,
    accounts: (c: Customer, _: unknown, ctx: Context) => {
      const viewer = requireViewer(ctx);
      if (viewer.role !== 'ADMIN' && viewer.id !== c.id) {
        throw createGraphQLError('Not your accounts', { extensions: { code: 'FORBIDDEN' } });
      }
      return ctx.loaders.accountsByCustomer.load(c.id);
    },
  },

  Account: {
    balance: (a: Account, _: unknown, ctx: Context) => {
      assertCanSeeAccount(ctx, a);
      return money(a.balance);
    },
    owner: async (a: Account, _: unknown, ctx: Context) => (await ctx.loaders.customer.load(a.customerId))!,
    transactions: (
      a: Account,
      args: { first?: number; after?: string; filter?: { from?: string | null; to?: string | null } },
      ctx: Context,
    ) => {
      assertCanSeeAccount(ctx, a);
      return connection(ctx.db.transactionsForAccount(a.id, args.filter ?? {}), args);
    },
  },

  Transaction: {
    amount: (t: Transaction) => money(t.amount),
  },
};

export const schema = createSchema<Context>({ typeDefs, resolvers });
