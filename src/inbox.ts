import { DatabaseSync } from "node:sqlite";

/** Delivery ledger, not conversation history. Unknown work never automatically replays. */
export class Inbox {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS inbox (
        id TEXT PRIMARY KEY, state TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL
      );
      UPDATE inbox SET state='uncertain' WHERE state='processing';`);
  }
  claim(id: string): boolean {
    const now = Date.now();
    return (
      Number(
        this.db
          .prepare("INSERT OR IGNORE INTO inbox VALUES (?, ?, ?, ?)")
          .run(id, "processing", now, now).changes,
      ) === 1
    );
  }
  finish(id: string, state: "completed" | "failed" | "uncertain"): void {
    this.db
      .prepare("UPDATE inbox SET state=?, updated=? WHERE id=?")
      .run(state, Date.now(), id);
  }
  status(id: string): string | undefined {
    return (
      this.db.prepare("SELECT state FROM inbox WHERE id=?").get(id) as
        | { state: string }
        | undefined
    )?.state;
  }
  close(): void {
    this.db.close();
  }
}
