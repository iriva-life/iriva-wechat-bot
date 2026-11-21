import type { AgentTask } from "./agents/index.js";
import {
  ConversationStore,
  type Snapshot,
  type SummaryResult,
} from "./conversation.js";
import { WorkerJobs } from "./jobs.js";
/** Summaries reserve the same five slots, but never hold up the inbound handler. */
export class ConversationMaintenance {
  private running = new Map<string, Promise<void>>();
  private retryAfter = new Map<string, number>();
  private stopped = false;
  constructor(
    private store: ConversationStore,
    private jobs: WorkerJobs,
    private summarize: (
      task: AgentTask,
      snapshot: Snapshot,
    ) => Promise<SummaryResult>,
    private report: (success: boolean) => void = () => {},
  ) {}
  kick() {
    if (this.stopped) return;
    for (const { accountId, scope } of this.store.pendingSummaries()) {
      const key = `${accountId}:${scope}`;
      if (this.running.has(key) || (this.retryAfter.get(key) ?? 0) > Date.now())
        continue;
      const snapshot = this.store.snapshot(accountId, scope);
      const senderId = scope.startsWith("private:")
        ? scope.slice(8)
        : (snapshot.rows.findLast((r) => r.role === "user")?.senderId ??
          "summary");
      const lease = this.jobs.acquire({ senderId, groupId: scope }, "summary");
      if (!lease) break;
      const task: AgentTask = {
        accountId,
        senderId,
        groupId: scope,
        messageId: `summary:${snapshot.cutoff}`,
        text: "总结聊天记录",
        role: "other",
        jobId: lease.id,
        workerSlot: lease.slot,
      };
      const work = this.summarize(task, snapshot)
        .then((result) => {
          this.store.applySummary(snapshot, result);
          this.retryAfter.delete(key);
          this.report(true);
        })
        .catch(() => {
          this.retryAfter.set(key, Date.now() + 60_000);
          this.report(false);
        })
        .finally(() => {
          lease.release();
          this.running.delete(key);
          if (!this.stopped) queueMicrotask(() => this.kick());
        });
      this.running.set(key, work);
    }
  }
  async close() {
    this.stopped = true;
    await Promise.allSettled(this.running.values());
  }
}
