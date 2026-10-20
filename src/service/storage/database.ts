import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MIGRATIONS } from './migrations';

export type Params = Record<string, SQLInputValue>;

/**
 * Thin wrapper around Node's built-in SQLite driver (`node:sqlite`).
 *
 * The built-in driver is used instead of a native addon (e.g. better-sqlite3)
 * because the service is shipped inside a VSIX and may be executed by VS
 * Code's bundled Electron runtime; native addons would need to be compiled for
 * every Electron ABI and platform.
 */
export class Database {
  readonly raw: DatabaseSync;
  private txDepth = 0;

  constructor(filename: string) {
    if (filename !== ':memory:') {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
    }
    this.raw = new DatabaseSync(filename);
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA synchronous = NORMAL;');
    if (filename !== ':memory:') {
      try {
        fs.chmodSync(filename, 0o600);
      } catch {
        // best effort on platforms without POSIX permissions
      }
    }
    this.migrate();
  }

  run(sql: string, params: Params = {}): { changes: number; lastInsertRowid: number } {
    const result = this.raw.prepare(sql).run(params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  get<T>(sql: string, params: Params = {}): T | undefined {
    return this.raw.prepare(sql).get(params) as T | undefined;
  }

  all<T>(sql: string, params: Params = {}): T[] {
    return this.raw.prepare(sql).all(params) as T[];
  }

  /** Runs `fn` inside an IMMEDIATE transaction (nested calls join the outer one). */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth++;
      try {
        return fn();
      } finally {
        this.txDepth--;
      }
    }
    this.raw.exec('BEGIN IMMEDIATE');
    this.txDepth = 1;
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    } finally {
      this.txDepth = 0;
    }
  }

  schemaVersion(): number {
    const row = this.get<{ user_version: number }>('PRAGMA user_version');
    return row?.user_version ?? 0;
  }

  private migrate(): void {
    const current = this.schemaVersion();
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) {
        continue;
      }
      this.transaction(() => {
        this.raw.exec(migration.sql);
        this.raw.exec(`PRAGMA user_version = ${migration.version}`);
      });
    }
  }

  close(): void {
    if (this.raw.isOpen) {
      this.raw.close();
    }
  }
}
