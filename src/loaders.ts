import DataLoader from 'dataloader';
import type { Account, Customer, Db } from './db.js';

/**
 * One set of loaders per request: batching collapses N lookups in a request into one query,
 * and per-request caching means one user's data is never served from another user's cache.
 */
export function createLoaders(db: Db) {
  return {
    customer: new DataLoader<string, Customer | undefined>(async (ids) => db.customersByIds(ids)),
    account: new DataLoader<string, Account | undefined>(async (ids) => db.accountsByIds(ids)),
    accountsByCustomer: new DataLoader<string, Account[]>(async (ids) => db.accountsByCustomerIds(ids)),
  };
}
export type Loaders = ReturnType<typeof createLoaders>;
