import { DatabaseSync } from "node:sqlite";

export interface D1Meta {
  changes: number;
  last_row_id: number;
}

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: D1Meta;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<Record<string, unknown>>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

declare global {
  // Expose D1Database & D1PreparedStatement globally so existing src/*.ts files compile without @cloudflare/workers-types
  type D1Database = import("./d1").D1Database;
  type D1PreparedStatement = import("./d1").D1PreparedStatement;
}

const RETORNA_FILAS = /^\s*(SELECT|PRAGMA)\b/i;
const TIENE_RETURNING = /\bRETURNING\b/i;

class StatementAdapter implements D1PreparedStatement {
  private sqlite: DatabaseSync;
  private query: string;
  private params: unknown[];

  constructor(sqlite: DatabaseSync, query: string, params: unknown[] = []) {
    this.sqlite = sqlite;
    this.query = query;
    this.params = params.map((v) => (v === undefined ? null : v));
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new StatementAdapter(this.sqlite, this.query, values);
  }

  executeSync<T = Record<string, unknown>>(): D1Result<T> {
    const stmt = this.sqlite.prepare(this.query);
    if (RETORNA_FILAS.test(this.query) || TIENE_RETURNING.test(this.query)) {
      const rows = stmt.all(...(this.params as any[])) as T[];
      const changesRow = this.sqlite.prepare("SELECT changes() AS c, last_insert_rowid() AS l").get() as { c: number; l: number } | undefined;
      return {
        results: rows,
        success: true,
        meta: {
          changes: TIENE_RETURNING.test(this.query) ? rows.length : Number(changesRow?.c ?? 0),
          last_row_id: Number(changesRow?.l ?? 0),
        },
      };
    }
    const info = stmt.run(...(this.params as any[]));
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(info.changes ?? 0),
        last_row_id: Number(info.lastInsertRowid ?? 0),
      },
    };
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const { results } = this.executeSync<Record<string, unknown>>();
    if (!results.length) return null;
    const row = results[0];
    if (colName !== undefined) return (row[colName] as T) ?? null;
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.executeSync<T>();
  }

  async run(): Promise<D1Result<Record<string, unknown>>> {
    return this.executeSync<Record<string, unknown>>();
  }
}

export function crearBaseDatosD1(ruta = process.env.SQLITE_DB_PATH || "/tmp/facturacion_ve.sqlite"): D1Database {
  const sqlite = new DatabaseSync(ruta);
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("PRAGMA journal_mode = WAL;");

  return {
    prepare(query: string): D1PreparedStatement {
      return new StatementAdapter(sqlite, query);
    },
    async batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const resultados: D1Result<T>[] = [];
        for (const s of statements) {
          if (s instanceof StatementAdapter) {
            resultados.push(s.executeSync<T>());
          } else {
            resultados.push(await s.all<T>());
          }
        }
        sqlite.exec("COMMIT");
        return resultados;
      } catch (err) {
        try {
          sqlite.exec("ROLLBACK");
        } catch {
          // ignore rollback error
        }
        throw err;
      }
    },
  };
}
