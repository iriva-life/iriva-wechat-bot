import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { bubbleDelay, splitBubbles, type PacingOptions } from "./bubbles.js";

export class SafeRetryError extends Error {}
export interface Delivery {
  id: string;
  targetType: "group" | "admin";
  targetId: string;
  text: string;
}
export interface OutboxRow extends Delivery {
  sequence: number;
  status: string;
  attempts: number;
}
export interface OutboxOptions extends PacingOptions {
  send: (delivery: Delivery) => Promise<void>;
  /** Must re-check admin recipients and group allowlist at delivery time. */
  authorize: (delivery: Delivery) => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxBubbleLength?: number;
}
export class BubbleOutbox {
  private db: DatabaseSync;
  private running?: Promise<void>;
  private stopped = false;
  constructor(
    path: string,
    private options: OutboxOptions,
  ) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS outbox_batches(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,
      targetType TEXT NOT NULL,targetId TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0);
      UPDATE outbox SET status='uncertain' WHERE status='sending';`);
  }
  enqueue(delivery: Delivery): boolean {
    if (this.stopped) throw new Error("Outbox closed");
    if (
      !delivery.id ||
      !delivery.targetId ||
      !["group", "admin"].includes(delivery.targetType)
    )
      throw new Error("Invalid delivery");
    if (!this.options.authorize(delivery)) throw new Error("Delivery denied");
    const bubbles = splitBubbles(delivery.text, this.options.maxBubbleLength);
    if (!bubbles.length) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.db
        .prepare("INSERT OR IGNORE INTO outbox_batches(id) VALUES (?)")
        .run(delivery.id);
      if (!inserted.changes) {
        this.db.exec("COMMIT");
        return false;
      }
      for (const [index, text] of bubbles.entries())
        this.db
          .prepare(
            "INSERT INTO outbox(id,targetType,targetId,text) VALUES (?,?,?,?)",
          )
          .run(
            `${delivery.id}:${index}`,
            delivery.targetType,
            delivery.targetId,
            text,
          );
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  list(): OutboxRow[] {
    return this.db
      .prepare("SELECT * FROM outbox ORDER BY sequence")
      .all() as unknown as OutboxRow[];
  }
  drain(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async run(): Promise<void> {
    // An uncertain earlier bubble blocks later bubbles to the same recipient.
    while (!this.stopped) {
      const row = this.db
        .prepare(
          `SELECT * FROM outbox o WHERE status='pending' AND NOT EXISTS
        (SELECT 1 FROM outbox p WHERE p.targetType=o.targetType AND p.targetId=o.targetId
        AND p.sequence<o.sequence AND p.status IN ('pending','sending','uncertain','failed'))
        ORDER BY sequence LIMIT 1`,
        )
        .get() as unknown as OutboxRow | undefined;
      if (!row) break;
      if (!this.options.authorize(row)) {
        this.db
          .prepare("UPDATE outbox SET status='cancelled' WHERE sequence=?")
          .run(row.sequence);
        continue;
      }
      await (
        this.options.sleep ??
        ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
      )(bubbleDelay(row.text, this.options, this.options.random));
      if (this.stopped) break;
      if (!this.options.authorize(row)) {
        this.db
          .prepare("UPDATE outbox SET status='cancelled' WHERE sequence=?")
          .run(row.sequence);
        continue;
      }
      this.db
        .prepare(
          "UPDATE outbox SET status='sending',attempts=attempts+1 WHERE sequence=?",
        )
        .run(row.sequence);
      try {
        await this.options.send(row);
        this.db
          .prepare("UPDATE outbox SET status='sent' WHERE sequence=?")
          .run(row.sequence);
      } catch (error) {
        const safe = error instanceof SafeRetryError;
        const status = safe
          ? row.attempts < 2
            ? "pending"
            : "failed"
          : "uncertain";
        this.db
          .prepare("UPDATE outbox SET status=? WHERE sequence=?")
          .run(status, row.sequence);
        // Known pre-dispatch failures retry at most 3 times, with pacing each time.
      }
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    await this.running;
    this.db.close();
  }
}
