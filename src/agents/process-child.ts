import {
  createRuntime,
  type AgentRuntime,
  type ToolDefinition,
} from "wayline-agent-runtime";
import {
  openSessionStore,
  type ManagedSessionStore,
} from "wayline-agent-runtime/storage";
import { AcpUpdateProjector } from "wayline-agent-runtime/acp";
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentConnection,
} from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { realpathSync } from "node:fs";
import { openAICompatibleModel, type ModelOptions } from "./model.js";

// Bootstrap credentials stay on the private Node IPC channel. All session traffic uses ACP stdio.
let runtime: AgentRuntime | undefined;
let store: ManagedSessionStore | undefined;
let connection: AgentConnection | undefined;
const sessions = new Map<
  string,
  { prompts: string[]; tools: string[]; controller?: AbortController }
>();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const s of sessions.values()) s.controller?.abort();
  await runtime?.close();
  await store?.close();
  connection?.close();
  process.disconnect?.();
}
process.on("disconnect", () => {
  void stop().finally(() => process.exit(0));
});
process.on("message", (m: any) => {
  if (m?.type === "close") void stop().finally(() => process.exit(0));
  if (m?.type === "init")
    void initialize(m).catch(() => {
      process.send?.({ type: "error" });
      void stop().finally(() => process.exit(1));
    });
});
async function initialize(message: {
  name: string;
  filename: string;
  model: ModelOptions;
  tools: ToolDefinition[];
}) {
  if (runtime) throw new Error("Already initialized");
  store = await openSessionStore({
    namespace: message.name,
    sqlite: { filename: message.filename },
  });
  runtime = createRuntime({
    model: openAICompatibleModel(message.model),
    sessionStore: store,
    builtins: { bash: false, compression: false },
    config: { maxToolRounds: 8, maxToolCalls: 12, timeoutMs: 120_000 },
    tools: message.tools.map((tool) => ({
      ...tool,
      executionPolicy: "exclusive",
      async execute(args, context) {
        context.signal?.throwIfAborted();
        if (!sessions.get(context.session.id)?.controller)
          throw new Error("No active session");
        const response = await connection!.client.request<{ result: unknown }>(
          "_iriva/tool",
          { sessionId: context.session.id, name: tool.name, args },
        );
        return response.result;
      },
    })),
  });
  const root = realpathSync(process.cwd());
  connection = agent({ name: `iriva-${message.name}` })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, promptCapabilities: {} },
      authMethods: [],
      agentInfo: { name: `iriva-${message.name}`, version: "0.1.0" },
    }))
    .onRequest(methods.agent.session.new, async ({ params }) => {
      if (realpathSync(params.cwd) !== root || params.mcpServers.length)
        throw new Error("Unsupported workspace/MCP configuration");
      const metadata = params._meta?.iriva as
        | { sessionId: string; tools: string[]; prompts: string[] }
        | undefined;
      if (
        !metadata ||
        typeof metadata.sessionId !== "string" ||
        !Array.isArray(metadata.tools) ||
        !Array.isArray(metadata.prompts) ||
        metadata.prompts.some((p) => typeof p !== "string")
      )
        throw new Error("Host session metadata required");
      if (sessions.has(metadata.sessionId))
        throw new Error("Duplicate session");
      const created = await runtime!.createSession({
        sessionId: metadata.sessionId,
        tools: metadata.tools,
      });
      sessions.set(created.sessionId, {
        tools: metadata.tools,
        prompts: metadata.prompts,
      });
      return { sessionId: created.sessionId };
    })
    .onRequest(methods.agent.session.prompt, async (context) => {
      const state = sessions.get(context.params.sessionId);
      if (!state || state.controller) throw new Error("Session unavailable");
      const controller = new AbortController();
      state.controller = controller;
      const abort = () => controller.abort();
      context.signal.addEventListener("abort", abort, { once: true });
      const projector = new AcpUpdateProjector({
        sessionId: context.params.sessionId,
        client: context.client,
        maxPendingUpdates: 256,
        signal: controller.signal,
        deliveryTimeoutMs: 10_000,
        onFailure: () => controller.abort(),
      });
      try {
        const content = context.params.prompt.map((p) => {
          if (p.type !== "text") throw new Error("Text only");
          return { type: "text" as const, text: p.text };
        });
        const result = await runtime!.prompt({
          sessionId: context.params.sessionId,
          tools: state.tools,
          promptInjections: state.prompts,
          content,
          signal: controller.signal,
          onEvent: (e) => projector.observe(e),
          ...(state.tools.length ? {} : { budget: { maxToolCalls: 0 } }),
        });
        projector.ensureFinalText(
          result.content.map((p) => p.text).join(""),
          result.runId,
        );
        await projector.drain();
        return { stopReason: "end_turn" as const };
      } catch (error) {
        if (controller.signal.aborted)
          return { stopReason: "cancelled" as const };
        throw new Error("Agent run failed");
      } finally {
        context.signal.removeEventListener("abort", abort);
        sessions.delete(context.params.sessionId);
      }
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      sessions.get(params.sessionId)?.controller?.abort();
    })
    .connect(
      ndJsonStream(
        Writable.toWeb(process.stdout),
        Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
      ),
    );
  connection.closed.then(() => {
    void stop().finally(() => process.exit(0));
  });
  process.send?.({ type: "ready" });
}
