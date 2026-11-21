import { randomUUID } from "node:crypto";
export interface JobInfo {
  id: string;
  slot: number;
  kind: "reply" | "summary";
  senderId: string;
  groupId: string;
  startedAt: number;
  stage: string;
  tool?: string;
}
/** Shared capacity for foreground work and background summaries. */
export class WorkerJobs {
  private active = new Map<string, JobInfo>();
  constructor(readonly limit = 5) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5)
      throw new Error("Worker limit must be 1..5");
  }
  acquire(task: { senderId: string; groupId: string }, kind: JobInfo["kind"]) {
    const occupied = new Set([...this.active.values()].map((j) => j.slot));
    const slot = Array.from({ length: this.limit }, (_, i) => i).find(
      (i) => !occupied.has(i),
    );
    if (slot === undefined) return null;
    const id = randomUUID();
    this.active.set(id, {
      id,
      slot,
      kind,
      senderId: task.senderId,
      groupId: task.groupId,
      startedAt: Date.now(),
      stage: "starting",
    });
    return {
      id,
      slot,
      release: () => {
        this.active.delete(id);
      },
    };
  }
  update(id: string | undefined, stage: string, tool?: string) {
    const job = id ? this.active.get(id) : undefined;
    if (job) {
      job.stage = stage;
      if (tool !== undefined) job.tool = tool;
      else if (!["tool_call", "tool_call_update"].includes(stage))
        job.tool = undefined;
    }
  }
  list() {
    return [...this.active.values()].map((j) => ({
      ...j,
      elapsedSeconds: Math.floor((Date.now() - j.startedAt) / 1000),
    }));
  }
}
export function isWorkerStatusQuestion(text: string): boolean {
  const remaining = text
    .toLowerCase()
    .replace(/\s/g, "")
    .replace(
      /请帮我|请|当前|现在|所有|正在工作|正在运行|运行中|的|一下|有哪些|是什么|查看|查询|列出|看看|显示|状态|进度|列表|有多少|多少个|在干嘛|[？?。！!]/g,
      "",
    );
  return /^(?:workers?|工作任务|工作进程|任务进度)$/.test(remaining);
}
