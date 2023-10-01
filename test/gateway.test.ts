import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { signToken } from '../src/auth.js';
import { Db } from '../src/db.js';

let app: ReturnType<typeof createApp>;
beforeEach(() => {
  app = createApp(new Db());
});

async function gql(query: string, opts: { as?: string; role?: 'CUSTOMER' | 'ADMIN'; variables?: object } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.as) headers.authorization = `Bearer ${await signToken({ id: opts.as, role: opts.role ?? 'CUSTOMER' })}`;
  const res = await app.yoga.fetch('http://test/graphql', {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables: opts.variables }),
  });
  return (await res.json()) as { data?: any; errors?: { message: string; extensions?: { code?: string } }[]; extensions?: { dbQueries?: number } };
}

describe('authentication', () => {
  it('rejects anonymous access to me', async () => {
    const r = await gql('{ me { id } }');
    expect(r.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a forged token', async () => {
    const res = await app.yoga.fetch('http://test/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not.a.token' },
      body: JSON.stringify({ query: '{ me { id } }' }),
    });
    const r = (await res.json()) as { errors?: { extensions?: { code?: string } }[] };
    expect(r.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
  });

  it('returns the signed-in customer with their email', async () => {
    const r = await gql('{ me { id email accounts { id balance { formatted } } } }', { as: 'cus_2' });
    expect(r.data.me.id).toBe('cus_2');
    expect(r.data.me.email).toContain('@example.com');
    expect(r.data.me.accounts.length).toBeGreaterThan(0);
  });
});

describe('authorization', () => {
  it('forbids customers from admin queries', async () => {
    const r = await gql('{ customers { totalCount } }', { as: 'cus_2' });
    expect(r.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });

  it('forbids reading another customer\'s accounts through a nested path', async () => {
    const mine = await gql('{ me { accounts { id owner { id } } } }', { as: 'cus_2' });
    expect(mine.errors).toBeUndefined();
    // An admin can read any customer; a customer cannot, even via relationships.
    const other = await gql('{ customer(id: "cus_3") { id } }', { as: 'cus_2' });
    expect(other.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });

  it('lets admins read everyone and hides nothing from them', async () => {
    const r = await gql('{ customer(id: "cus_3") { email accounts { id } } }', { as: 'cus_1', role: 'ADMIN' });
    expect(r.errors).toBeUndefined();
    expect(r.data.customer.email).toContain('@example.com');
  });
});

describe('DataLoader batching (N+1)', () => {
  it('loads 20 customers, their accounts, and each account owner in 3 round trips', async () => {
    const r = await gql('{ customers(first: 20) { edges { node { id accounts { id owner { name } } } } } }', {
      as: 'cus_1',
      role: 'ADMIN',
    });
    expect(r.errors).toBeUndefined();
    const accounts = r.data.customers.edges.flatMap((e: any) => e.node.accounts);
    expect(accounts.length).toBeGreaterThan(20);
    // Without DataLoader: 1 + 20 (accounts) + N (owners) queries. With it: list + 1 batched accounts query, owners cached.
    expect(r.extensions?.dbQueries).toBeLessThanOrEqual(3);
  });
});

describe('cursor pagination', () => {
  it('pages through transactions without overlap', async () => {
    const q = `query($after: String) { me { accounts { transactions(first: 5, after: $after) {
      totalCount edges { cursor node { id } } pageInfo { hasNextPage endCursor } } } } }`;
    const p1 = await gql(q, { as: 'cus_2' });
    const t1 = p1.data.me.accounts[0].transactions;
    const p2 = await gql(q, { as: 'cus_2', variables: { after: t1.pageInfo.endCursor } });
    const t2 = p2.data.me.accounts[0].transactions;
    const ids1 = t1.edges.map((e: any) => e.node.id);
    const ids2 = t2.edges.map((e: any) => e.node.id);
    expect(ids1).toHaveLength(5);
    expect(ids2).toHaveLength(5);
    expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
    expect(t1.pageInfo.hasNextPage).toBe(true);
  });

  it('rejects page sizes over the limit', async () => {
    const r = await gql('{ me { accounts { transactions(first: 500) { totalCount } } } }', { as: 'cus_2' });
    expect(r.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  });
});

describe('query depth limit', () => {
  it('rejects abusive nesting before execution', async () => {
    const r = await gql('{ me { accounts { owner { accounts { owner { accounts { owner { id } } } } } } } }', { as: 'cus_2' });
    expect(r.errors?.[0]?.extensions?.code).toBe('QUERY_TOO_DEEP');
    expect(r.data).toBeUndefined();
  });
});

describe('transfer mutation', () => {
  const M = `mutation($input: TransferInput!) { transfer(input: $input) {
    transferId replayed userErrors { field message } from { balance { amount } } to { balance { amount } } } }`;

  async function twoAccountCustomer() {
    for (let i = 2; i <= 40; i++) {
      const r = await gql('{ me { accounts { id balance { amount } } } }', { as: `cus_${i}` });
      if (r.data.me.accounts.length >= 2) return { id: `cus_${i}`, accounts: r.data.me.accounts };
    }
    throw new Error('no customer with two accounts');
  }

  it('moves money, and replays safely with the same idempotency key', async () => {
    const { id, accounts } = await twoAccountCustomer();
    const input = { fromAccountId: accounts[0].id, toAccountId: accounts[1].id, amount: 100, idempotencyKey: 'key-123456' };
    const first = await gql(M, { as: id, variables: { input } });
    expect(first.data.transfer.userErrors).toEqual([]);
    expect(first.data.transfer.from.balance.amount).toBe(accounts[0].balance.amount - 100);

    const retry = await gql(M, { as: id, variables: { input } });
    expect(retry.data.transfer.replayed).toBe(true);
    const after = await gql('{ me { accounts { balance { amount } } } }', { as: id });
    expect(after.data.me.accounts[0].balance.amount).toBe(accounts[0].balance.amount - 100); // charged once
  });

  it('returns a user error for insufficient funds', async () => {
    const { id, accounts } = await twoAccountCustomer();
    const input = { fromAccountId: accounts[0].id, toAccountId: accounts[1].id, amount: 1e12, idempotencyKey: 'key-big-0001' };
    const r = await gql(M, { as: id, variables: { input } });
    expect(r.data.transfer.userErrors[0].field).toBe('amount');
  });

  it('does not reveal or touch another customer\'s account', async () => {
    const { id, accounts } = await twoAccountCustomer();
    const input = { fromAccountId: 'acc_1_1', toAccountId: accounts[0].id, amount: 10, idempotencyKey: 'key-steal-01' };
    const r = await gql(M, { as: id, variables: { input } });
    expect(r.data.transfer.userErrors[0]).toEqual({ field: 'fromAccountId', message: 'Account not found.' });
  });
});
