type SqliteStatement = {
  all: (...values: unknown[]) => Record<string, unknown>[];
  get: (...values: unknown[]) => Record<string, unknown> | undefined;
  run: (...values: unknown[]) => { changes: number | bigint };
};

type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
};

type DatabaseSyncConstructor = new (path: string) => SqliteDatabase;

export interface AcceptanceTeamTestAccount {
  id: string;
  email: string;
}

export interface AcceptanceTeamTestFixture {
  sqlite: SqliteDatabase;
  db: SqliteD1;
}

export interface AcceptanceTeamTestFixtureOptions {
  accounts?: AcceptanceTeamTestAccount[];
  migrations?: string[];
  schemaSql?: string[];
}

export class SqliteD1Statement {
  constructor(
    private readonly sqlite: SqliteDatabase,
    private readonly sql: string,
    private readonly bindings: unknown[] = [],
  ) {}

  bind(...bindings: unknown[]): SqliteD1Statement {
    return new SqliteD1Statement(this.sqlite, this.sql, bindings);
  }

  async first<T>(): Promise<T | null> {
    return this.sqlite.prepare(this.sql).get(...this.bindings) as T | undefined ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.sqlite.prepare(this.sql).all(...this.bindings) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = this.sqlite.prepare(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

export class SqliteD1 {
  constructor(readonly sqlite: SqliteDatabase) {}

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this.sqlite, sql);
  }

  async batch(statements: SqliteD1Statement[]): Promise<Array<{ success: true; meta: { changes: number } }>> {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

export async function createAcceptanceTeamTestFixture(
  options: AcceptanceTeamTestFixtureOptions = {},
): Promise<AcceptanceTeamTestFixture> {
  // @ts-ignore Node-only test harness module.
  const sqliteModule = await import("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };
  const sqlite = new sqliteModule.DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(
    "CREATE TABLE accounts(account_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  );
  await applyAcceptanceMigration(sqlite, "0015_acceptance_teams.sql");
  for (const migration of options.migrations ?? []) await applyAcceptanceMigration(sqlite, migration);
  for (const sql of options.schemaSql ?? []) sqlite.exec(sql);
  for (const account of options.accounts ?? []) {
    sqlite.prepare("INSERT INTO accounts(account_id, email, created_at, updated_at) VALUES (?, ?, 1, 1)")
      .run(account.id, account.email);
  }
  return { sqlite, db: new SqliteD1(sqlite) };
}

export async function applyAcceptanceMigration(sqlite: SqliteDatabase, filename: string): Promise<void> {
  // @ts-ignore Node-only test harness module.
  const fs = await import("node:fs") as { readFileSync: (url: URL, encoding: "utf8") => string };
  sqlite.exec(fs.readFileSync(new URL(`../../migrations/${filename}`, import.meta.url), "utf8"));
}
