/**
 * In-memory synthetic banking data with a query counter.
 * Every method call counts as one "database round trip", so tests and responses can prove
 * whether DataLoader removed N+1 queries.
 */
export type Role = 'CUSTOMER' | 'ADMIN';
export interface Customer { id: string; name: string; email: string; role: Role }
export interface Account { id: string; customerId: string; type: 'SAVINGS' | 'CURRENT'; balance: number; currency: 'INR' }
export interface Transaction { id: string; accountId: string; date: string; description: string; amount: number; category: string }

let seed = 7;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;

const FIRST = ['Aarav', 'Diya', 'Kabir', 'Meera', 'Rohan', 'Sara', 'Vihaan', 'Anika', 'Ishaan', 'Tara'];
const LAST = ['Shah', 'Iyer', 'Mehta', 'Rao', 'Kapoor', 'Nair', 'Joshi', 'Gupta'];
const MERCHANTS: [string, string][] = [
  ['UPI-GROCERY MART', 'groceries'], ['UPI-SWIGGY', 'dining'], ['METRO RECHARGE', 'transport'],
  ['ELECTRICITY BILL', 'utilities'], ['SALARY CREDIT', 'salary'], ['PHARMACY PLUS', 'health'], ['MOVIE TICKETS', 'entertainment'],
];

export class Db {
  queries = 0;
  readonly customers = new Map<string, Customer>();
  readonly accounts = new Map<string, Account>();
  readonly transactions: Transaction[] = [];
  private readonly idempotency = new Map<string, unknown>();

  constructor(customerCount = 40) {
    for (let c = 1; c <= customerCount; c++) {
      const name = `${pick(FIRST)} ${pick(LAST)}`;
      const id = `cus_${c}`;
      this.customers.set(id, { id, name, email: `${name.toLowerCase().replace(' ', '.')}${c}@example.com`, role: c === 1 ? 'ADMIN' : 'CUSTOMER' });
      const accountCount = 1 + Math.floor(rand() * 3);
      for (let a = 1; a <= accountCount; a++) {
        const accId = `acc_${c}_${a}`;
        this.accounts.set(accId, { id: accId, customerId: id, type: a === 1 ? 'SAVINGS' : 'CURRENT', balance: Math.round(rand() * 500_000) / 1, currency: 'INR' });
        for (let t = 0; t < 30; t++) {
          const [description, category] = pick(MERCHANTS);
          const amount = category === 'salary' ? 85_000 : -Math.round(rand() * 5_000);
          const day = String(1 + Math.floor(rand() * 28)).padStart(2, '0');
          this.transactions.push({ id: `txn_${accId}_${t}`, accountId: accId, date: `2026-09-${day}`, description, amount, category });
        }
      }
    }
    this.transactions.sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : b.date.localeCompare(a.date)));
  }

  customersByIds(ids: readonly string[]): (Customer | undefined)[] {
    this.queries++;
    return ids.map((id) => this.customers.get(id));
  }

  accountsByCustomerIds(ids: readonly string[]): Account[][] {
    this.queries++;
    const all = [...this.accounts.values()];
    return ids.map((id) => all.filter((a) => a.customerId === id));
  }

  accountsByIds(ids: readonly string[]): (Account | undefined)[] {
    this.queries++;
    return ids.map((id) => this.accounts.get(id));
  }

  listCustomers(): Customer[] {
    this.queries++;
    return [...this.customers.values()];
  }

  transactionsForAccount(accountId: string, filter: { from?: string | null; to?: string | null }): Transaction[] {
    this.queries++;
    return this.transactions.filter(
      (t) => t.accountId === accountId && (!filter.from || t.date >= filter.from) && (!filter.to || t.date <= filter.to),
    );
  }

  /** Atomic transfer (single-threaded JS = no interleaving inside this method). */
  transfer(input: { fromAccountId: string; toAccountId: string; amount: number; idempotencyKey: string }) {
    this.queries++;
    const cached = this.idempotency.get(input.idempotencyKey);
    if (cached) return { replayed: true as const, result: cached };
    const from = this.accounts.get(input.fromAccountId)!;
    const to = this.accounts.get(input.toAccountId)!;
    from.balance -= input.amount;
    to.balance += input.amount;
    const today = new Date().toISOString().slice(0, 10);
    const id = `txn_transfer_${this.transactions.length}`;
    this.transactions.unshift(
      { id: `${id}_out`, accountId: from.id, date: today, description: `TRANSFER TO ${to.id}`, amount: -input.amount, category: 'transfer' },
      { id: `${id}_in`, accountId: to.id, date: today, description: `TRANSFER FROM ${from.id}`, amount: input.amount, category: 'transfer' },
    );
    const result = { transferId: id, from, to };
    this.idempotency.set(input.idempotencyKey, result);
    return { replayed: false as const, result };
  }
}
