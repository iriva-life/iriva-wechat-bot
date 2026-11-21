import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Role = "admin" | "other" | "blocker";
export type DocumentKind = "knowledge" | "context" | "prompt" | "behavior";
export type ViolationCategory =
  | "secret_theft"
  | "privilege_bypass"
  | "destructive_action";
export interface ReviewedIncident {
  accountId: string;
  messageId: string;
  groupId: string;
  senderWxid: string;
  category: ViolationCategory;
  evidence: string;
  reviewer: "server-moderator";
  severity: "severe";
}
export interface BlockRequest {
  id: string;
  senderWxid: string;
  status: "pending" | "approved" | "rejected";
  incidentCount: number;
  createdAt: string;
  decidedBy?: string;
}
export interface AdminNotification {
  id: string;
  requestId: string;
  adminAlias: string;
  recipientWxid: string;
  senderWxid: string;
  incidentCount: number;
}
export interface PolicyDocument {
  kind: DocumentKind;
  key: string;
  value: string;
  updatedBy: string;
  updatedAt: string;
}
type Row = Record<string, unknown>;
const categories = new Set<ViolationCategory>([
  "secret_theft",
  "privilege_bypass",
  "destructive_action",
]);
const documentKinds = new Set<DocumentKind>([
  "knowledge",
  "context",
  "prompt",
  "behavior",
]);
function nonempty(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} is required`);
  return value.trim();
}
function requestFrom(row: Row): BlockRequest {
  return {
    id: String(row.id),
    senderWxid: String(row.sender_wxid),
    status: row.status as BlockRequest["status"],
    incidentCount: Number(row.incident_count),
    createdAt: String(row.created_at),
    ...(row.decided_by ? { decidedBy: String(row.decided_by) } : {}),
  };
}

/** Host-owned authorization database. Never register these methods directly as model tools. */
export class StateStore {
  private readonly db: DatabaseSync;
  private readonly aliases: Set<string>;

  constructor(path: string, options: { adminAliases?: string[] } = {}) {
    this.aliases = new Set(
      (options.adminAliases ?? ["EnRomantice", "quietfire1"]).map((a) =>
        nonempty(a, "admin alias").toLowerCase(),
      ),
    );
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS identities (
        alias TEXT PRIMARY KEY, wxid TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
        verified_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blockers (
        wxid TEXT PRIMARY KEY, request_id TEXT NOT NULL, approved_by TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, message_id TEXT NOT NULL,
        group_id TEXT NOT NULL, sender_wxid TEXT NOT NULL, category TEXT NOT NULL,
        evidence TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(account_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS block_requests (
        id TEXT PRIMARY KEY, sender_wxid TEXT NOT NULL, status TEXT NOT NULL,
        incident_count INTEGER NOT NULL, created_at TEXT NOT NULL, decided_by TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_per_sender
        ON block_requests(sender_wxid) WHERE status='pending';
      CREATE TABLE IF NOT EXISTS admin_notifications (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES block_requests(id),
        admin_alias TEXT NOT NULL, delivered_at TEXT,
        UNIQUE(request_id, admin_alias)
      );
      CREATE TABLE IF NOT EXISTS policy_documents (
        kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(kind,key)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Trusted local provisioning only. A message, nickname, or model output is never identity evidence. */
  bindIdentity(input: {
    alias: string;
    wxid: string;
    source: "manual" | "directory";
    verified: true;
  }): void {
    if (
      input.verified !== true ||
      !["manual", "directory"].includes(input.source)
    )
      throw new Error("Verified trusted identity evidence required");
    const alias = nonempty(input.alias, "alias").toLowerCase();
    const wxid = nonempty(input.wxid, "wxid");
    if (wxid.endsWith("@chatroom"))
      throw new Error("A group cannot be an identity");
    const prior = this.db
      .prepare("SELECT wxid FROM identities WHERE alias=?")
      .get(alias);
    if (prior && prior.wxid !== wxid)
      throw new Error(
        "Alias already bound to another identity; resolve conflict locally",
      );
    this.db
      .prepare(
        "INSERT INTO identities(alias,wxid,source,verified_at) VALUES(?,?,?,?) ON CONFLICT(alias) DO UPDATE SET source=excluded.source,verified_at=excluded.verified_at",
      )
      .run(alias, wxid, input.source, new Date().toISOString());
  }

  roleFor(wxid: string): Role {
    const identity = this.db
      .prepare("SELECT alias FROM identities WHERE wxid=?")
      .get(wxid);
    if (identity && this.aliases.has(String(identity.alias))) return "admin";
    return this.db.prepare("SELECT wxid FROM blockers WHERE wxid=?").get(wxid)
      ? "blocker"
      : "other";
  }

  adminWxids(): string[] {
    return (this.db.prepare("SELECT alias,wxid FROM identities").all() as Row[])
      .filter((r) => this.aliases.has(String(r.alias)))
      .map((r) => String(r.wxid));
  }

  unresolvedAdminAliases(): string[] {
    return [...this.aliases].filter(
      (alias) =>
        !this.db
          .prepare("SELECT wxid FROM identities WHERE alias=?")
          .get(alias),
    );
  }

  private requireAdmin(actorWxid: string): void {
    if (this.roleFor(actorWxid) !== "admin")
      throw new Error("Admin permission required");
  }

  incidentCount(senderWxid: string): number {
    return Number(
      this.db
        .prepare("SELECT COUNT(*) AS count FROM incidents WHERE sender_wxid=?")
        .get(senderWxid)?.count ?? 0,
    );
  }

  /** Call only after an independent server moderation review, with sender/message bound by ingress. */
  recordReviewedIncident(input: ReviewedIncident): {
    count: number;
    duplicate: boolean;
    request?: BlockRequest;
  } {
    if (
      input.reviewer !== "server-moderator" ||
      input.severity !== "severe" ||
      !categories.has(input.category)
    )
      throw new Error("Invalid reviewed severe incident");
    for (const key of [
      "accountId",
      "messageId",
      "groupId",
      "senderWxid",
      "evidence",
    ] as const)
      nonempty(input[key], key);
    if (!input.groupId.endsWith("@chatroom"))
      throw new Error("Only group incidents may be recorded");
    if (this.roleFor(input.senderWxid) !== "other")
      throw new Error("Only other users enter violation review");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare(
          "SELECT sender_wxid FROM incidents WHERE account_id=? AND message_id=?",
        )
        .get(input.accountId, input.messageId);
      if (existing && existing.sender_wxid !== input.senderWxid)
        throw new Error("Message identity conflict");
      if (!existing)
        this.db
          .prepare("INSERT INTO incidents VALUES(?,?,?,?,?,?,?,?)")
          .run(
            randomUUID(),
            input.accountId,
            input.messageId,
            input.groupId,
            input.senderWxid,
            input.category,
            input.evidence.slice(0, 4000),
            new Date().toISOString(),
          );
      const count = this.incidentCount(input.senderWxid);
      let row = this.db
        .prepare(
          "SELECT * FROM block_requests WHERE sender_wxid=? AND status='pending'",
        )
        .get(input.senderWxid);
      if (!existing && count > 3 && !row) {
        const id = randomUUID();
        this.db
          .prepare("INSERT INTO block_requests VALUES(?,?,'pending',?,?,NULL)")
          .run(id, input.senderWxid, count, new Date().toISOString());
        for (const alias of this.aliases)
          this.db
            .prepare("INSERT INTO admin_notifications VALUES(?,?,?,NULL)")
            .run(randomUUID(), id, alias);
        row = this.db
          .prepare("SELECT * FROM block_requests WHERE id=?")
          .get(id);
      }
      this.db.exec("COMMIT");
      return {
        count,
        duplicate: !!existing,
        ...(row ? { request: requestFrom(row) } : {}),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listPendingRequests(): BlockRequest[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM block_requests WHERE status='pending' ORDER BY created_at",
        )
        .all() as Row[]
    ).map(requestFrom);
  }

  requestEvidence(requestId: string, actorWxid: string): ReviewedIncident[] {
    this.requireAdmin(actorWxid);
    const request = this.db
      .prepare("SELECT sender_wxid FROM block_requests WHERE id=?")
      .get(requestId);
    if (!request) throw new Error("Unknown request");
    return (
      this.db
        .prepare(
          "SELECT * FROM incidents WHERE sender_wxid=? ORDER BY created_at",
        )
        .all(String(request.sender_wxid)) as Row[]
    ).map((r) => ({
      accountId: String(r.account_id),
      messageId: String(r.message_id),
      groupId: String(r.group_id),
      senderWxid: String(r.sender_wxid),
      category: r.category as ViolationCategory,
      evidence: String(r.evidence),
      reviewer: "server-moderator",
      severity: "severe",
    }));
  }

  decideRequest(
    actorWxid: string,
    requestId: string,
    decision: "approve" | "reject",
  ): BlockRequest {
    this.requireAdmin(actorWxid);
    if (!["approve", "reject"].includes(decision))
      throw new Error("Invalid decision");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT * FROM block_requests WHERE id=?")
        .get(requestId);
      if (!row || row.status !== "pending")
        throw new Error("Request not pending");
      if (
        decision === "approve" &&
        this.roleFor(String(row.sender_wxid)) === "admin"
      )
        throw new Error("Cannot block an admin");
      this.db
        .prepare("UPDATE block_requests SET status=?,decided_by=? WHERE id=?")
        .run(
          decision === "approve" ? "approved" : "rejected",
          actorWxid,
          requestId,
        );
      if (decision === "approve")
        this.db
          .prepare(
            "INSERT INTO blockers VALUES(?,?,?) ON CONFLICT(wxid) DO NOTHING",
          )
          .run(String(row.sender_wxid), requestId, actorWxid);
      const result = requestFrom(
        this.db
          .prepare("SELECT * FROM block_requests WHERE id=?")
          .get(requestId)!,
      );
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  pendingNotifications(): AdminNotification[] {
    return (
      this.db
        .prepare(
          `SELECT n.id,n.request_id,n.admin_alias,i.wxid,r.sender_wxid,r.incident_count
      FROM admin_notifications n JOIN identities i ON i.alias=n.admin_alias
      JOIN block_requests r ON r.id=n.request_id WHERE n.delivered_at IS NULL AND r.status='pending'`,
        )
        .all() as Row[]
    )
      .filter((r) => this.aliases.has(String(r.admin_alias)))
      .map((r) => ({
        id: String(r.id),
        requestId: String(r.request_id),
        adminAlias: String(r.admin_alias),
        recipientWxid: String(r.wxid),
        senderWxid: String(r.sender_wxid),
        incidentCount: Number(r.incident_count),
      }));
  }

  /** Re-check at actual send time; queued notifications can become stale or lose authorization. */
  mayDeliverNotification(
    notificationId: string,
    recipientWxid: string,
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT n.admin_alias,i.wxid FROM admin_notifications n
      JOIN block_requests r ON r.id=n.request_id JOIN identities i ON i.alias=n.admin_alias
      WHERE n.id=? AND n.delivered_at IS NULL AND r.status='pending'`,
      )
      .get(notificationId);
    return (
      !!row &&
      row.wxid === recipientWxid &&
      this.aliases.has(String(row.admin_alias)) &&
      this.roleFor(recipientWxid) === "admin"
    );
  }

  /** Admin-only reversal; keep the reviewed incidents and decisions as audit history. */
  unblock(actorWxid: string, targetWxid: string): boolean {
    this.requireAdmin(actorWxid);
    nonempty(targetWxid, "target wxid");
    return (
      this.db.prepare("DELETE FROM blockers WHERE wxid=?").run(targetWxid)
        .changes > 0
    );
  }

  markNotificationDelivered(id: string): void {
    this.db
      .prepare("UPDATE admin_notifications SET delivered_at=? WHERE id=?")
      .run(new Date().toISOString(), id);
  }

  setDocument(
    actorWxid: string,
    kind: DocumentKind,
    key: string,
    value: string,
  ): void {
    this.requireAdmin(actorWxid);
    if (!documentKinds.has(kind)) throw new Error("Invalid document kind");
    nonempty(key, "document key");
    if (typeof value !== "string" || value.length > 100_000)
      throw new Error("Invalid document value");
    this.db
      .prepare(
        `INSERT INTO policy_documents VALUES(?,?,?,?,?) ON CONFLICT(kind,key)
      DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
      )
      .run(kind, key, value, actorWxid, new Date().toISOString());
  }

  getDocument(kind: DocumentKind, key: string): PolicyDocument | undefined {
    const row = this.db
      .prepare("SELECT * FROM policy_documents WHERE kind=? AND key=?")
      .get(kind, key);
    return row
      ? {
          kind: row.kind as DocumentKind,
          key: String(row.key),
          value: String(row.value),
          updatedBy: String(row.updated_by),
          updatedAt: String(row.updated_at),
        }
      : undefined;
  }

  listDocuments(kind: DocumentKind): PolicyDocument[] {
    return (
      this.db
        .prepare("SELECT * FROM policy_documents WHERE kind=? ORDER BY key")
        .all(kind) as Row[]
    ).map((row) => ({
      kind: row.kind as DocumentKind,
      key: String(row.key),
      value: String(row.value),
      updatedBy: String(row.updated_by),
      updatedAt: String(row.updated_at),
    }));
  }
}
