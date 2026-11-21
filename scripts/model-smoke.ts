import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessAgentOrchestrator } from "../src/agents/index.js";

// Explicit live provider smoke: no bridge, no WeChat, no real identities or data.
const dir = await mkdtemp(join(tmpdir(), "iriva-model-smoke-"));
let agent:
  | Awaited<ReturnType<typeof createProcessAgentOrchestrator>>
  | undefined;
let toolCalls = 0;
try {
  agent = await createProcessAgentOrchestrator({
    dataDir: dir,
    modelConfig: {
      baseUrl: process.env.MODEL_BASE_URL!,
      apiKey: process.env.MODEL_API_KEY!,
      model: process.env.MODEL_ID!,
    },
    tools: [
      {
        name: "knowledge_read",
        description: "读取测试知识库中的一个事实。",
        roles: ["other"],
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute() {
          toolCalls++;
          return { fact: "IRIVA 的测试颜色是蓝色。" };
        },
      },
    ],
  });
  const task = {
    accountId: "wxid_testbot",
    senderId: "wxid_testuser",
    groupId: "123@chatroom",
    messageId: "smoke",
    role: "other" as const,
    text: "请使用 knowledge_read 查询测试颜色，再用一句中文回答。",
  };
  const verdict = await agent.review(task);
  if (verdict.severe) throw new Error("Benign question unexpectedly severe");
  const answer = await agent.answer(task);
  if (!answer.text.includes("蓝") || toolCalls < 1)
    throw new Error("Expected tool execution or fact missing");
  console.log(
    JSON.stringify({
      ok: true,
      model: process.env.MODEL_ID,
      reviewer: "passed",
      worker: "tool_fact_returned",
      toolCalls,
      leader: "answered",
      wechatMessagesSent: 0,
    }),
  );
} finally {
  await agent?.close();
  await rm(dir, { recursive: true, force: true });
}
