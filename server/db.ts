import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs, { type Database as SqlDatabase, type SqlValue } from "sql.js";
import { Pool, type PoolClient, type QueryResultRow } from "@neondatabase/serverless";

export type DatabaseValue = string | number | boolean | null | undefined;
export type DatabaseRow = Record<string, unknown>;
export type QueryConnection = {
  one<T extends DatabaseRow>(sql: string, ...values: DatabaseValue[]): Promise<T | undefined>;
  many<T extends DatabaseRow>(sql: string, ...values: DatabaseValue[]): Promise<T[]>;
  run(sql: string, ...values: DatabaseValue[]): Promise<{ changes: number }>;
};

const databaseUrl = process.env.DATABASE_URL;
if (process.env.VERCEL && !databaseUrl) {
  throw new Error("DATABASE_URL doit être configuré dans les variables d’environnement Vercel.");
}

const useNeon = Boolean(databaseUrl);
let sqlite: SqlDatabase | undefined;
let neonPool: Pool | undefined;
let inTransaction = false;
let sqliteTransactionDone: Promise<void> | undefined;

function toSqliteValue(value: DatabaseValue): SqlValue {
  if (value === undefined || value === null) return null;
  return typeof value === "boolean" ? Number(value) : value;
}

function postgresSql(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function rowsFromSqlite<T extends DatabaseRow>(sql: string, values: DatabaseValue[]): T[] {
  const db = sqlite;
  if (!db) throw new Error("La base SQLite n’est pas initialisée.");
  const statement = db.prepare(sql);
  try {
    statement.bind(values.map(toSqliteValue));
    const rows: T[] = [];
    while (statement.step()) rows.push(statement.getAsObject() as T);
    return rows;
  } finally {
    statement.free();
  }
}

function sqliteQueryConnection(db: SqlDatabase): QueryConnection {
  return {
    async one<T extends DatabaseRow>(sql: string, ...values: DatabaseValue[]): Promise<T | undefined> {
      return rowsFromSqlite<T>(sql, values)[0];
    },
    async many<T extends DatabaseRow>(sql: string, ...values: DatabaseValue[]): Promise<T[]> {
      return rowsFromSqlite<T>(sql, values);
    },
    async run(sql: string, ...values: DatabaseValue[]): Promise<{ changes: number }> {
      db.run(sql, values.map(toSqliteValue));
      const changes = db.getRowsModified();
      if (!inTransaction) persistSqlite();
      return { changes };
    },
  };
}

function postgresQueryConnection(client: Pool | PoolClient): QueryConnection {
  return {
    async one<T extends DatabaseRow>(sql: string, ...values: DatabaseValue[]): Promise<T | undefined> {
      const result = await client.query<T & QueryResultRow>(postgresSql(sql), values);
      return result.rows[0] as T | undefined;
    },
    async many<T extends DatabaseRow>(sql: string, ...values: DatabaseValue[]): Promise<T[]> {
      const result = await client.query<T & QueryResultRow>(postgresSql(sql), values);
      return result.rows as T[];
    },
    async run(sql: string, ...values: DatabaseValue[]): Promise<{ changes: number }> {
      const result = await client.query(postgresSql(sql), values);
      return { changes: result.rowCount ?? 0 };
    },
  };
}

function persistSqlite() {
  if (!sqlite || !databasePath) return;
  fs.writeFileSync(databasePath, Buffer.from(sqlite.export()));
}

const databasePath = process.env.DATABASE_PATH ?? "./data/reservations.sqlite";

export const database: QueryConnection = {
  async one<T extends DatabaseRow>(sql: string, ...values: DatabaseValue[]): Promise<T | undefined> {
    await waitForSqliteTransaction();
    return useNeon
      ? postgresQueryConnection(neonPool!).one<T>(sql, ...values)
      : sqliteQueryConnection(sqlite!).one<T>(sql, ...values);
  },
  async many<T extends DatabaseRow>(sql: string, ...values: DatabaseValue[]): Promise<T[]> {
    await waitForSqliteTransaction();
    return useNeon
      ? postgresQueryConnection(neonPool!).many<T>(sql, ...values)
      : sqliteQueryConnection(sqlite!).many<T>(sql, ...values);
  },
  async run(sql: string, ...values: DatabaseValue[]): Promise<{ changes: number }> {
    await waitForSqliteTransaction();
    return useNeon
      ? postgresQueryConnection(neonPool!).run(sql, ...values)
      : sqliteQueryConnection(sqlite!).run(sql, ...values);
  },
};

async function waitForSqliteTransaction() {
  while (!useNeon && inTransaction && sqliteTransactionDone) await sqliteTransactionDone;
}

export async function transaction<T>(callback: (connection: QueryConnection) => Promise<T>): Promise<T> {
  if (useNeon) {
    const client = await neonPool!.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      const result = await callback(postgresQueryConnection(client));
      await client.query("COMMIT");
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const db = sqlite;
  if (!db) throw new Error("La base SQLite n’est pas initialisée.");
  await waitForSqliteTransaction();
  let markDone!: () => void;
  sqliteTransactionDone = new Promise<void>((resolve) => {
    markDone = resolve;
  });
  let transactionStarted = false;
  try {
    db.run("BEGIN IMMEDIATE");
    inTransaction = true;
    transactionStarted = true;
    const result = await callback(sqliteQueryConnection(db));
    db.run("COMMIT");
    inTransaction = false;
    transactionStarted = false;
    persistSqlite();
    return result;
  } catch (error) {
    if (transactionStarted) db.run("ROLLBACK");
    throw error;
  } finally {
    inTransaction = false;
    markDone();
    sqliteTransactionDone = undefined;
  }
}

export async function lockRoom(connection: QueryConnection, roomId: number) {
  if (useNeon) await connection.one("SELECT pg_advisory_xact_lock(?) AS locked", roomId);
}

async function initializeSqlite() {
  const require = createRequire(import.meta.url);
  fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(path.dirname(require.resolve("sql.js")), file),
  });
  sqlite = fs.existsSync(databasePath)
    ? new SQL.Database(new Uint8Array(fs.readFileSync(databasePath)))
    : new SQL.Database();
  sqlite.run("PRAGMA foreign_keys = ON");
}

const schemaSqlite = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    building TEXT NOT NULL,
    capacity INTEGER NOT NULL CHECK (capacity > 0),
    accessible INTEGER NOT NULL DEFAULT 0 CHECK (accessible IN (0, 1)),
    equipment TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
  );
  CREATE TABLE IF NOT EXISTS reservations (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    room_id INTEGER NOT NULL REFERENCES rooms(id),
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (starts_at < ends_at)
  );
  CREATE TABLE IF NOT EXISTS room_favorites (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, room_id)
  );
  CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS support_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_user ON password_reset_tokens(user_id);
  CREATE INDEX IF NOT EXISTS reservations_room_time ON reservations(room_id, status, starts_at, ends_at);
  CREATE INDEX IF NOT EXISTS reservations_user_time ON reservations(user_id, starts_at DESC);
  CREATE INDEX IF NOT EXISTS support_messages_user_time ON support_messages(user_id, created_at, id);
`;

const schemaPostgres = [
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'student'
    CHECK (role IN ('student', 'admin')), created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (LOWER(email))",
  `CREATE TABLE IF NOT EXISTS rooms (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, building TEXT NOT NULL,
    capacity INTEGER NOT NULL CHECK (capacity > 0), accessible INTEGER NOT NULL DEFAULT 0
    CHECK (accessible IN (0, 1)), equipment TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
  )`,
  `CREATE TABLE IF NOT EXISTS reservations (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
    room_id INTEGER NOT NULL REFERENCES rooms(id), starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed', 'cancelled')), created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (starts_at < ends_at)
  )`,
  `CREATE TABLE IF NOT EXISTS room_favorites (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, room_id)
  )`,
  "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS support_messages (
    id BIGSERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_user ON password_reset_tokens(user_id)",
  "CREATE INDEX IF NOT EXISTS reservations_room_time ON reservations(room_id, status, starts_at, ends_at)",
  "CREATE INDEX IF NOT EXISTS reservations_user_time ON reservations(user_id, starts_at DESC)",
  "CREATE INDEX IF NOT EXISTS support_messages_user_time ON support_messages(user_id, created_at, id)",
];

async function initializeDatabase() {
  if (useNeon) {
    neonPool = new Pool({ connectionString: databaseUrl });
    for (const sql of schemaPostgres) await neonPool.query(sql);
    await neonPool.query("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''");
  } else {
    await initializeSqlite();
    sqlite!.run(schemaSqlite);
    const userColumns = sqlite!.exec("PRAGMA table_info(users)")[0]?.values ?? [];
    if (!userColumns.some((column) => column[1] === "role")) {
      sqlite!.run("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'student'");
    }
    const roomColumns = sqlite!.exec("PRAGMA table_info(rooms)")[0]?.values ?? [];
    if (!roomColumns.some((column) => column[1] === "active")) {
      sqlite!.run("ALTER TABLE rooms ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
    }
    if (!roomColumns.some((column) => column[1] === "description")) {
      sqlite!.run("ALTER TABLE rooms ADD COLUMN description TEXT NOT NULL DEFAULT ''");
    }
  }

  await database.run("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT DO NOTHING", "min_duration_minutes", "30");
  await database.run("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT DO NOTHING", "max_duration_minutes", "240");
  await database.run("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT DO NOTHING", "min_notice_minutes", "0");

  const roomCount = await database.one<{ count: number | string }>("SELECT COUNT(*) AS count FROM rooms");
  if (Number(roomCount?.count ?? 0) === 0) {
    const rooms = [
      ["Salle Atlas", "Bâtiment A · 1er étage", 8, 1, "Écran · Tableau blanc"],
      ["Salle Horizon", "Bâtiment A · 2e étage", 12, 1, "Écran · Visioconférence"],
      ["Salle Pixel", "Bâtiment B · Rez-de-chaussée", 6, 0, "Tableau blanc"],
      ["Salle Agora", "Bâtiment B · 1er étage", 20, 1, "Écran · Visioconférence · Tableau blanc"],
      ["Salle Studio", "Bâtiment C · 2e étage", 4, 0, "Écran"],
    ] as const;
    await transaction(async (connection) => {
      for (const room of rooms) {
        await connection.run(
          "INSERT INTO rooms (name, building, capacity, accessible, equipment) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
          ...room,
        );
      }
    });
  }
}

await initializeDatabase();

export async function closeDatabase() {
  if (neonPool) await neonPool.end();
}
