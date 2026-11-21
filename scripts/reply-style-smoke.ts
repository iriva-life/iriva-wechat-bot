import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProcessAgentOrchestrator,
  type AgentTask,
} from "../src/agents/index.js";
// Synthetic context only. No WeChat connection, production database or outbound delivery.
const dir = await mkdtemp(join(tmpdir(), "iriva-wording-smoke-"));
let agents:
  | Awaited<ReturnType<typeof createProcessAgentOrchestrator>>
  | undefined;
try {
  agents = await createProcessAgentOrchestrator({
    dataDir: dir,
    modelConfig: {
      baseUrl: process.env.MODEL_BASE_URL!,
      apiKey: process.env.MODEL_API_KEY!,
      model: process.env.MODEL_ID!,
    },
    tools: [],
    getGlobalPrompt: () => "你叫IRIVA，是一只青鸟。",
    getContext: (t) => t.conversationContext ?? "",
  });
  const base: AgentTask = {
    accountId: "wxid_testbot",
    senderId: "wxid_testperson",
    groupId: "123@chatroom",
    messageId: "smoke",
    text: "二加二是多少？",
    role: "other",
  };
  const contexts = [
    {
      currentSenderId: base.senderId,
      history: [{ sender: base.senderId, text: "以后称呼我XM" }],
      memories: [],
      addressing: { asked: false, refused: false },
    },
    {
      currentSenderId: base.senderId,
      history: [],
      memories: [],
      addressing: { asked: false, refused: false },
    },
    {
      currentSenderId: base.senderId,
      history: [{ sender: base.senderId, text: "我不想提供称呼" }],
      memories: [],
      addressing: { asked: true, refused: true },
    },
  ];
  const outputs = [];
  for (const [i, context] of contexts.entries()) {
    const result = await agents.answer({
      ...base,
      messageId: `smoke-${i}`,
      conversationContext: JSON.stringify(context),
    });
    console.log(
      JSON.stringify({
        case: i,
        text: result.text,
        askedAddressing: result.askedAddressing,
      }),
    );
    if (i === 0) {
      assert.match(result.text, /^XM[，,]/);
      assert.equal(result.askedAddressing, false);
    }
    if (i === 1) assert.equal(result.askedAddressing, true);
    if (i === 2) {
      assert.equal(result.askedAddressing, false);
      assert.doesNotMatch(result.text, /怎么称呼|如何称呼|怎么叫你/);
    }
    outputs.push(result);
  }
  const busy = await agents.compose(
    { ...base, conversationContext: JSON.stringify(contexts[0]) },
    { kind: "busy", facts: { active: 5, limit: 5 } },
  );
  assert.equal(busy.askedAddressing, false);
  assert.match(busy.text, /XM/);
  outputs.push(busy);
  console.log(
    JSON.stringify({
      ok: true,
      outputs: outputs.map(({ text, askedAddressing }) => ({
        text,
        askedAddressing,
      })),
      wechatMessagesSent: 0,
    }),
  );
} finally {
  await agents?.close();
  await rm(dir, { recursive: true, force: true });
}
