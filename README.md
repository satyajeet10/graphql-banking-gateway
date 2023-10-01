# GraphQL Banking Gateway

A production-minded GraphQL API for customers, accounts, and transactions, built with **GraphQL Yoga**,
**DataLoader**, and **jose** (JWT). Focused on the problems real GraphQL APIs hit: N+1 queries, authorization
through nested relationships, abusive queries, pagination, and safe retries of money movement.

> Northbank is a fictional bank; all data is synthetic and in memory.

## What it demonstrates

| Concept | Where |
|---|---|
| **N+1 elimination:** per-request DataLoaders batch lookups; 20 customers + their accounts + every account's owner in **3** round trips (visible as `extensions.dbQueries` on every response) | `src/loaders.ts`, `src/app.ts` |
| **Authentication:** HS256 JWTs verified per request; bad or expired tokens become anonymous, never crashes | `src/auth.ts` |
| **Authorization at three levels:** operation (`customers` is admin-only), object (only your own accounts, even via `owner → accounts`), and field (`email` is null for other viewers) | `src/schema.ts` |
| **Query depth limiting:** a custom validation rule rejects deeply nested queries before any resolver runs | `src/depth-limit.ts` |
| **Relay-style cursor pagination** with opaque cursors and a max page size | `src/pagination.ts` |
| **Idempotent mutation:** `transfer` with an `idempotencyKey`; a retry replays the result instead of charging twice | `Mutation.transfer` |
| **Errors as data:** expected failures (insufficient funds) return `userErrors`; unexpected errors are masked | `TransferPayload`, `maskedErrors` |
| **No existence leaks:** another customer's account ID gets the same "Account not found" as a fake one | `Mutation.transfer` |

## Run

```bash
npm install
npm run dev                          # http://localhost:4000/graphql (GraphiQL)
npm run token -- cus_2 CUSTOMER      # prints a header to paste into GraphiQL's Headers tab
npm run token -- cus_1 ADMIN         # cus_1 is the admin
```

Try in GraphiQL:

```graphql
# As cus_1 (ADMIN): check extensions.dbQueries in the response
{
  customers(first: 20) {
    edges { node { name accounts { type balance { formatted } owner { name } } } }
  }
}

# As any customer
mutation {
  transfer(input: { fromAccountId: "acc_2_1", toAccountId: "acc_2_2", amount: 500, idempotencyKey: "demo-key-001" }) {
    transferId replayed userErrors { field message }
    from { balance { formatted } }
  }
}
```

```bash
npm test          # 13 tests
npm run typecheck
```

## Tests (13, all passing)
Anonymous and forged-token rejection; own profile with email; admin-only queries forbidden to customers;
cross-customer access blocked; admin full access; N+1 batching bounded to 3 queries; non-overlapping cursor
pages; page-size limit; depth-limit rejection; transfer success with idempotent replay (charged once);
insufficient funds as a user error; no access to another customer's account.

## Design decisions
1. **Loaders per request, not global.** Batching and caching stay scoped to one viewer, so cached data can never
   leak across users.
2. **Authorization in resolvers on the type, not only on root fields.** GraphQL lets clients reach the same object
   through many paths (`me → accounts`, `customer → accounts`, `account → owner → accounts`); checking on
   `Account` protects every path.
3. **User errors vs exceptions.** Clients handle `userErrors` as normal UI states; exceptions are reserved for
   bugs and are masked so internals never leak.

## Next steps
- Swap the in-memory store for Postgres (the `Db` interface already mirrors batched queries).
- Query cost analysis (weighting list fields by `first`) alongside the depth limit.
- Persisted queries and a React client using Apollo Client with fragment colocation.
