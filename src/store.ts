import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export type Row = Record<string, any>;
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS migrations(name TEXT PRIMARY KEY)",
    );
    for (const name of readdirSync(new URL("../migrations/", import.meta.url))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      if (this.one("SELECT name FROM migrations WHERE name=?", name)) continue;
      this.tx(() => {
        this.db.exec(
          readFileSync(
            new URL("../migrations/" + name, import.meta.url),
            "utf8",
          ),
        );
        this.run("INSERT INTO migrations VALUES(?)", name);
      });
    }
    // Processes do not survive snapshot restoration. Preserve partial text and mark unfinished work.
    this.run("UPDATE messages SET status='interrupted' WHERE status='running'");
    this.run(
      "UPDATE turns SET status=CASE WHEN status='running' THEN 'interrupted' ELSE status END, speech_status=CASE WHEN speech_status='running' THEN 'interrupted' ELSE speech_status END WHERE status='running' OR speech_status='running'",
    );
  }
  run(sql: string, ...args: any[]) {
    return this.db.prepare(sql).run(...args);
  }
  one(sql: string, ...args: any[]): Row | undefined {
    return this.db.prepare(sql).get(...args);
  }
  all(sql: string, ...args: any[]): Row[] {
    return this.db.prepare(sql).all(...args);
  }
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  conversation(owner: string, cid: string) {
    const c = this.one(
      "SELECT * FROM conversations WHERE id=? AND owner=?",
      cid,
      owner,
    );
    if (!c) throw new AppError("NOT_FOUND", "Conversation not found", 404);
    return c;
  }
  turn(owner: string, tid: string) {
    const t = this.one(
      "SELECT * FROM turns WHERE id=? AND owner=?",
      tid,
      owner,
    );
    if (!t) throw new AppError("NOT_FOUND", "Turn not found", 404);
    return t;
  }
  createConversation(owner: string, title: string) {
    const cid = id();
    this.run(
      "INSERT INTO conversations VALUES(?,?,?,0,?)",
      cid,
      owner,
      title,
      now(),
    );
    return this.conversation(owner, cid);
  }
  events(tid: string, after = 0) {
    return this.all(
      "SELECT * FROM events WHERE turn_id=? AND seq>? ORDER BY seq",
      tid,
      after,
    ).map((e) => ({ ...e, data: JSON.parse(e.data) }));
  }
  event(tid: string, type: string, data: Row) {
    const result = this.run(
      "INSERT INTO events(turn_id,type,data) VALUES(?,?,?)",
      tid,
      type,
      JSON.stringify(data),
    );
    return { seq: Number(result.lastInsertRowid), turn_id: tid, type, data };
  }
  close() {
    this.db.close();
  }
}
