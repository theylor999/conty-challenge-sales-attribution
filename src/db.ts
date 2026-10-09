import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

export type Param = SQLInputValue;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS creators (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS creator_coupons (
  code       TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL REFERENCES creators(id)
);
CREATE TABLE IF NOT EXISTS creator_handles (
  handle     TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL REFERENCES creators(id)
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  topic       TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id               TEXT PRIMARY KEY,
  name             TEXT,
  currency         TEXT NOT NULL,
  total_cents      INTEGER NOT NULL CHECK (total_cents >= 0),
  financial_status TEXT,
  cancelled_at     TEXT,
  created_at       TEXT NOT NULL,
  received_at      TEXT NOT NULL,
  creator_id       TEXT REFERENCES creators(id),
  rule             TEXT NOT NULL CHECK (rule IN ('coupon', 'utm', 'none')),
  evidence         TEXT NOT NULL,
  conflicts        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_by_creator ON orders(creator_id);

-- No foreign key to orders: a refund can arrive before its order.
CREATE TABLE IF NOT EXISTS refunds (
  refund_id       TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL,
  currency        TEXT,
  requested_cents INTEGER NOT NULL CHECK (requested_cents > 0),
  status          TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'capped', 'rejected')),
  applied_cents   INTEGER NOT NULL DEFAULT 0 CHECK (applied_cents >= 0),
  excess_cents    INTEGER NOT NULL DEFAULT 0 CHECK (excess_cents >= 0),
  reason          TEXT,
  created_at      TEXT NOT NULL,
  received_at     TEXT NOT NULL,
  resolved_at     TEXT
);
CREATE INDEX IF NOT EXISTS refunds_by_order ON refunds(order_id);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     TEXT NOT NULL REFERENCES orders(id),
  creator_id   TEXT REFERENCES creators(id),
  kind         TEXT NOT NULL CHECK (kind IN ('sale', 'refund', 'reversal')),
  amount_cents INTEGER NOT NULL,
  refund_id    TEXT REFERENCES refunds(refund_id),
  occurred_at  TEXT NOT NULL,
  recorded_at  TEXT NOT NULL,
  CHECK ((kind = 'sale' AND amount_cents >= 0) OR (kind <> 'sale' AND amount_cents < 0)),
  CHECK ((kind = 'refund') = (refund_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ledger_by_order ON ledger_entries(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_one_sale_per_order ON ledger_entries(order_id) WHERE kind = 'sale';
CREATE UNIQUE INDEX IF NOT EXISTS ledger_one_reversal_per_order ON ledger_entries(order_id) WHERE kind = 'reversal';
CREATE UNIQUE INDEX IF NOT EXISTS ledger_one_entry_per_refund ON ledger_entries(refund_id) WHERE refund_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
-- Last line of defense for the refund cap: the order's net can never go below zero.
CREATE TRIGGER IF NOT EXISTS ledger_net_not_negative BEFORE INSERT ON ledger_entries
WHEN NEW.kind <> 'sale'
BEGIN
  SELECT RAISE(ABORT, 'ledger net would go below zero')
  WHERE COALESCE((SELECT SUM(amount_cents) FROM ledger_entries WHERE order_id = NEW.order_id), 0) + NEW.amount_cents < 0;
END;
`;

/** The only module that touches node:sqlite. */
export class Db {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private inTransaction = false;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  run(sql: string, ...params: Param[]): { changes: number } {
    const result = this.statement(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  get<T>(sql: string, ...params: Param[]): T | undefined {
    return this.statement(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: Param[]): T[] {
    return this.statement(sql).all(...params) as T[];
  }

  /** BEGIN IMMEDIATE takes the write lock up front, so check-then-insert is safe across processes too. */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) throw new Error("nested transactions are not supported");
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  close(): void {
    this.db.close();
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
}
