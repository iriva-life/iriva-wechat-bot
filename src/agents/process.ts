import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ModelOptions } from "./model.js";
import {
  WORKER,
  LEADER,
  REVIEWER,
  authorizationPrompt,
  WECHAT_STYLE,
  type AgentTask,
  type HostTool,
  type ModerationVerdict,
} from "./index.js";

export interface ProcessAgentOptions {
  dataDir: string;
  modelConfig: Omit<ModelOptions, "fetch">;
  tools: readonly HostTool[];
  getGlobalPrompt?: () => string | Promise<string>;
  getContext?: (task: Readonly<AgentTask>) => string | Promise<string>;
}
interface Pending {
  task: Readonly<AgentTask>;
  selected: readonly string[];
  controller: AbortController;
  resolve(text: string): void;
  reject(error: Error): void;
  cleanup(): void;
}
class AgentProcess {
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  private pending = new Map<string, Pending>();
  private closing?: Promise<void>;
  private stopped = false;
  private tools: Map<string, HostTool>;
  constructor(
    name: string,
    options: ProcessAgentOptions,
    tools: readonly HostTool[],
  ) {
    this.tools = new Map(
      tools.map((tool) => [tool.name, { ...tool, roles: [...tool.roles] }]),
    );
    const typescript = import.meta.url.endsWith(".ts");
    this.child = fork(
      new URL(`./process-child.${typescript ? "ts" : "js"}`, import.meta.url),
      [],
      {
        execArgv: typescript ? ["--import", "tsx"] : [],
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        serialization: "advanced",
      },
    );
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`${name} startup timeout`));
        this.child.kill();
      }, 20_000);
      const onReady = (message: any) => {
        if (message?.type === "ready") {
          clearTimeout(timeout);
          this.child.off("message", onReady);
          resolve();
        } else if (message?.type === "error") {
          clearTimeout(timeout);
          reject(new Error(`${name} initialization failed`));
        }
      };
      this.child.on("message", onReady);
      this.child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      this.child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error(`${name} exited before ready`));
      });
    });
    this.child.on("message", (message: any) => {
      void this.receive(message);
    });
    this.child.on("exit", () => {
      this.stopped = true;
      for (const pending of this.pending.values()) {
        pending.controller.abort();
        pending.cleanup();
        pending.reject(
          new Error(`${name} process exited; tool outcome may be unknown`),
        );
      }
      this.pending.clear();
    });
    this.child.send({
      type: "init",
      name,
      filename: join(options.dataDir, `${name}.sqlite`),
      model: options.modelConfig,
      tools: tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    });
  }
  private send(message: unknown) {
    if (this.child.connected) this.child.send(message as any, () => {});
  }
  private async receive(message: any) {
    if (!message || typeof message !== "object") return;
    if (message.type === "tool") {
      const pending = this.pending.get(message.requestId);
      const tool = this.tools.get(message.name);
      if (
        !pending ||
        !tool ||
        pending.task.role === "blocker" ||
        !tool.roles.includes(pending.task.role) ||
        !pending.selected.includes(tool.name)
      ) {
        this.send({
          type: "toolResult",
          callId: message.callId,
          error: "Tool permission denied",
        });
        return;
      }
      try {
        pending.controller.signal.throwIfAborted();
        const result = await tool.execute(
          message.args,
          pending.task,
          pending.controller.signal,
        );
        this.send({ type: "toolResult", callId: message.callId, result });
      } catch {
        this.send({
          type: "toolResult",
          callId: message.callId,
          error: "Host tool failed or permission denied",
        });
      }
    } else if (message.type === "result" || message.type === "error") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.cleanup();
      if (message.type === "error")
        pending.reject(new Error("Agent run failed"));
      else pending.resolve(String(message.text));
    }
  }
  async run(
    task: Readonly<AgentTask>,
    sessionId: string,
    prompts: string[],
    text: string,
    selected: readonly string[],
    signal?: AbortSignal,
  ) {
    await this.ready;
    if (this.stopped || this.closing)
      throw new Error("Agent process unavailable");
    signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const controller = new AbortController();
      const abort = () => {
        controller.abort();
        this.send({ type: "cancel", id });
      };
      signal?.addEventListener("abort", abort, { once: true });
      const deadline = setTimeout(() => {
        abort();
        // A stuck runtime cannot safely admit new work. Do not replay tools.
        this.child.kill();
      }, 135_000);
      this.pending.set(id, {
        task,
        selected,
        controller,
        resolve,
        reject,
        cleanup() {
          clearTimeout(deadline);
          signal?.removeEventListener("abort", abort);
        },
      });
      this.send({ type: "run", id, sessionId, prompts, text, tools: selected });
    });
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = new Promise<void>((resolve) => {
      if (this.stopped) {
        resolve();
        return;
      }
      for (const pending of this.pending.values()) pending.controller.abort();
      const timer = setTimeout(() => this.child.kill(), 15_000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.send({ type: "close" });
    });
    return this.closing;
  }
}

/** Production boundary: one OS child process and SQLite store per independent agent. */
export async function createProcessAgentOrchestrator(
  options: ProcessAgentOptions,
) {
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  const worker = new AgentProcess("worker", options, options.tools);
  const leader = new AgentProcess("leader", options, []);
  const reviewer = new AgentProcess("reviewer", options, []);
  const processes = [worker, leader, reviewer];
  try {
    await Promise.all(processes.map((child) => child.ready));
  } catch (error) {
    await Promise.all(processes.map((child) => child.close()));
    throw error;
  }
  let closed = false;
  function principal(task: AgentTask): Readonly<AgentTask> {
    if (closed) throw new Error("Agent orchestrator closed");
    if (
      !["admin", "other"].includes(task.role) ||
      !task.senderId ||
      !task.groupId ||
      !task.messageId
    )
      throw new Error("Invalid or blocked task");
    return Object.freeze({ ...task });
  }
  return {
    async answer(input: AgentTask, signal?: AbortSignal) {
      const task = principal(input);
      const suffix = randomUUID();
      const workerSessionId = `worker:${suffix}`,
        leaderSessionId = `leader:${suffix}`;
      const globalPrompt = (await options.getGlobalPrompt?.()) ?? "";
      const context = (await options.getContext?.(task)) ?? "";
      const selected = options.tools
        .filter(
          (tool) => task.role !== "blocker" && tool.roles.includes(task.role),
        )
        .map((tool) => tool.name);
      const work = await worker.run(
        task,
        workerSessionId,
        [WORKER, globalPrompt, authorizationPrompt(task, selected)],
        JSON.stringify({ question: task.text, context }),
        selected,
        signal,
      );
      signal?.throwIfAborted();
      const text = (
        await leader.run(
          task,
          leaderSessionId,
          [LEADER, globalPrompt, authorizationPrompt(task, selected), WECHAT_STYLE],
          JSON.stringify({ question: task.text, workerResult: work }),
          [],
          signal,
        )
      ).trim();
      if (!text) throw new Error("Leader returned empty reply");
      return { text, workerSessionId, leaderSessionId };
    },
    async review(
      input: AgentTask,
      signal?: AbortSignal,
    ): Promise<ModerationVerdict> {
      const task = principal(input);
      const safe: ModerationVerdict = {
        severe: false,
        category: null,
        evidence: "",
        reason: "未确认严重违规",
      };
      if (task.role === "admin") return safe;
      try {
        const text = await reviewer.run(
          task,
          `reviewer:${randomUUID()}`,
          [REVIEWER],
          JSON.stringify({ originalMessage: task.text }),
          [],
          signal,
        );
        const value = JSON.parse(text);
        if (
          value?.severe !== true ||
          !["secret_theft", "privilege_bypass", "destructive_action"].includes(
            value.category,
          ) ||
          typeof value.evidence !== "string" ||
          !value.evidence.trim() ||
          !task.text.includes(value.evidence) ||
          typeof value.reason !== "string"
        )
          return safe;
        return {
          severe: true,
          category: value.category,
          evidence: value.evidence,
          reason: value.reason.slice(0, 500),
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { ...safe, reason: "审核不可用，未计次" };
      }
    },
    async close() {
      closed = true;
      await Promise.all(processes.map((child) => child.close()));
    },
  };
}
