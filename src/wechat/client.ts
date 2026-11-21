import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import {
  normalizeInbound,
  record,
  isGroupId,
  isUserId,
  type InboundMessage,
} from "./normalize.js";
import { SafeRetryError } from "./outbox.js";

export interface OneBotOptions {
  baseUrl: string;
  token: string;
  accountId: string;
  onMessage: (message: InboundMessage) => void | Promise<void>;
  onError?: (error: Error) => void;
  onReady?: () => void | Promise<void>;
  timeoutMs?: number;
}
type Pending = {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
export class OneBotClient {
  private socket?: WebSocket;
  private stopped = true;
  private verified = false;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private alive = true;
  private failures = 0;
  private pending = new Map<string, Pending>();
  private url: URL;
  constructor(private options: OneBotOptions) {
    this.url = new URL(options.baseUrl);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(this.url.hostname) ||
      this.url.protocol !== "http:" ||
      this.url.username ||
      this.url.password ||
      this.url.search ||
      this.url.hash
    )
      throw new Error(
        "Bridge must use loopback HTTP (use SSH tunnel remotely)",
      );
    if (!options.token || !isUserId(options.accountId))
      throw new Error("Verified account wxid and bridge token required");
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }
  private report(error: unknown): void {
    this.options.onError?.(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
  private connect(): void {
    if (this.stopped) return;
    const url = new URL("/ws", this.url);
    url.protocol = "ws:";
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.options.token}` },
      handshakeTimeout: this.options.timeoutMs ?? 15_000,
      maxPayload: 1024 * 1024,
    });
    this.socket = socket;
    socket.on("open", () => {
      this.alive = true;
      this.heartbeat = setInterval(() => {
        if (!this.alive) {
          socket.terminate();
          return;
        }
        this.alive = false;
        socket.ping();
      }, 30_000);
      void this.request("get_login_info")
        .then(async (data) => {
          if (this.socket !== socket || this.stopped) return;
          if (record(data).user_id !== this.options.accountId) {
            this.report(
              new Error(
                "Bridge login identity mismatch; message processing stopped",
              ),
            );
            this.close();
            return;
          }
          this.verified = true;
          this.failures = 0;
          await this.options.onReady?.();
        })
        .catch((error: unknown) => {
          this.report(error);
          socket.terminate();
        });
    });
    socket.on("pong", () => {
      this.alive = true;
    });
    socket.on("message", (bytes) => {
      try {
        const raw: unknown = JSON.parse(bytes.toString());
        const envelope = record(raw);
        if (typeof envelope.echo === "string") {
          const pending = this.pending.get(envelope.echo);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(envelope.echo);
            if (envelope.status === "ok") pending.resolve(envelope.data);
            else pending.reject(new Error("Bridge read action failed"));
          }
          return;
        }
        if (!this.verified) return;
        const message = normalizeInbound(raw, this.options.accountId);
        if (message)
          void Promise.resolve(this.options.onMessage(message)).catch(
            (error: unknown) => this.report(error),
          );
      } catch (error) {
        this.report(error);
      }
    });
    socket.on("error", (error) => this.report(error));
    socket.on("close", () => {
      this.verified = false;
      clearInterval(this.heartbeat);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Bridge disconnected"));
      }
      this.pending.clear();
      if (!this.stopped)
        this.retry = setTimeout(
          () => this.connect(),
          Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5)),
        );
    });
  }
  request(
    action: "get_login_info" | "get_contact_directory",
  ): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Bridge not connected"));
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error("Bridge read timed out"));
      }, this.options.timeoutMs ?? 15_000);
      this.pending.set(echo, { resolve, reject, timer });
      socket.send(JSON.stringify({ action, echo, params: {} }), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(echo);
          reject(error);
        }
      });
    });
  }
  async sendGroup(groupId: string, text: string): Promise<void> {
    if (!isGroupId(groupId)) throw new Error("Invalid group ID");
    await this.send("/send_group_msg", { group_id: groupId }, text);
  }
  /** Host must validate that recipient is currently an admin before calling. */
  async sendAdmin(adminWxid: string, text: string): Promise<void> {
    if (!isUserId(adminWxid)) throw new Error("Invalid admin wxid");
    await this.send("/send_private_msg", { user_id: adminWxid }, text);
  }
  private async send(
    path: string,
    target: Record<string, string>,
    text: string,
  ): Promise<void> {
    if (!this.verified || this.stopped)
      throw new SafeRetryError(
        "Bridge account not verified; nothing dispatched",
      );
    if (!text.trim()) throw new Error("Empty message");
    // After dispatch, even a timeout/5xx can mean the external effect happened.
    const response = await fetch(new URL(path, this.url), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...target,
        message: [{ type: "text", data: { text } }],
      }),
    });
    if (!response.ok)
      throw new Error(
        `Bridge send outcome unconfirmed (HTTP ${response.status})`,
      );
    const body = record(await response.json());
    if (body.status !== "ok")
      throw new Error("Bridge send outcome unconfirmed");
  }
  close(): void {
    this.stopped = true;
    this.verified = false;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Bridge closed"));
    }
    this.pending.clear();
    this.socket?.terminate();
  }
}
