import {
  createRuntime,
  type AgentRuntime,
  type ToolDefinition,
} from "wayline-agent-runtime";
import {
  openSessionStore,
  type ManagedSessionStore,
} from "wayline-agent-runtime/storage";
import { openAICompatibleModel, type ModelOptions } from "./model.js";
import { randomUUID } from "node:crypto";

// Internal executable only. It hosts exactly one independent Wayline runtime.
let runtime: AgentRuntime | undefined;
let store: ManagedSessionStore | undefined;
const signals = new Map<string, AbortController>();
const calls = new Map<
  string,
  { resolve(value: unknown): void; reject(error: Error): void }
>();
const sessionRequests = new Map<string, string>();
function send(value: unknown) {
  if (process.connected) process.send?.(value);
}
function fail(message: Record<string, unknown>, error: unknown) {
  send({
    type: "error",
    id: message.id,
    error: error instanceof Error ? error.message : "Agent process failed",
  });
}
process.on("message", (input: unknown) => {
  void dispatch(input).catch((error) =>
    fail(input as Record<string, unknown>, error),
  );
});
process.on("disconnect", () => {
  void stop().finally(() => process.exit(0));
});

async function stop() {
  for (const controller of signals.values()) controller.abort();
  for (const pending of calls.values())
    pending.reject(new Error("Agent process shutting down"));
  calls.clear();
  await runtime?.close();
  await store?.close();
}
async function dispatch(input: unknown) {
  if (!input || typeof input !== "object") return;
  const message = input as Record<string, any>;
  if (message.type === "init") {
    if (runtime) throw new Error("Runtime already initialized");
    store = await openSessionStore({
      namespace: message.name,
      sqlite: { filename: message.filename },
    });
    runtime = createRuntime({
      model: openAICompatibleModel(message.model as ModelOptions),
      sessionStore: store,
      builtins: { bash: false, compression: false },
      config: { maxToolRounds: 8, maxToolCalls: 12, timeoutMs: 120_000 },
      tools: (message.tools as ToolDefinition[]).map((tool) => ({
        ...tool,
        executionPolicy: "exclusive",
        async execute(args, context) {
          context.signal?.throwIfAborted();
          const requestId = sessionRequests.get(context.session.id);
          if (!requestId) throw new Error("No active host task");
          const callId = randomUUID();
          return new Promise((resolve, reject) => {
            const abort = () => {
              calls.delete(callId);
              reject(new Error("Tool call cancelled"));
            };
            context.signal?.addEventListener("abort", abort, { once: true });
            calls.set(callId, {
              resolve(value) {
                context.signal?.removeEventListener("abort", abort);
                resolve(value);
              },
              reject(error) {
                context.signal?.removeEventListener("abort", abort);
                reject(error);
              },
            });
            send({ type: "tool", requestId, callId, name: tool.name, args });
          });
        },
      })),
    });
    send({ type: "ready", pid: process.pid });
  } else if (message.type === "toolResult") {
    const pending = calls.get(message.callId);
    calls.delete(message.callId);
    if (message.error) pending?.reject(new Error(message.error));
    else pending?.resolve(message.result);
  } else if (message.type === "run") {
    if (!runtime) throw new Error("Runtime not initialized");
    const controller = new AbortController();
    signals.set(message.id, controller);
    sessionRequests.set(message.sessionId, message.id);
    try {
      await runtime.createSession({
        sessionId: message.sessionId,
        tools: message.tools,
      });
      const result = await runtime.prompt({
        sessionId: message.sessionId,
        tools: message.tools,
        signal: controller.signal,
        promptInjections: message.prompts,
        content: [{ type: "text", text: message.text }],
        ...(message.tools.length === 0 ? { budget: { maxToolCalls: 0 } } : {}),
      });
      send({
        type: "result",
        id: message.id,
        text: result.content.map((part) => part.text).join(""),
      });
    } finally {
      signals.delete(message.id);
      sessionRequests.delete(message.sessionId);
    }
  } else if (message.type === "cancel") signals.get(message.id)?.abort();
  else if (message.type === "close") {
    await stop();
    send({ type: "closed" });
    process.disconnect();
  }
}
