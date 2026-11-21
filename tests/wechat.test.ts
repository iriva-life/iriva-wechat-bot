import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import {
  normalizeInbound,
  splitBubbles,
  graphemes,
  bubbleDelay,
  BubbleOutbox,
  SafeRetryError,
  OneBotClient,
} from "../src/wechat/index.js";

const event = {
  post_type: "message",
  message_type: "group",
  self_id: "wxid_bot",
  group_id: "123@chatroom",
  sender: { user_id: "wxid_member" },
  message_id: "18446744073709551615",
  message: [
    { type: "text", data: { text: "问题" } },
    { type: "at", data: { qq: "wxid_bot" } },
  ],
};
test("normalizer preserves long IDs and structured mention; rejects private/self/mismatched/unsafe IDs", () => {
  assert.equal(
    normalizeInbound(event, "wxid_bot")?.messageId,
    event.message_id,
  );
  assert.deepEqual(normalizeInbound(event, "wxid_bot")?.mentions, ["wxid_bot"]);
  for (const patch of [
    { message_type: "private" },
    { is_self: true },
    { sender: { user_id: "wxid_bot" } },
    { self_id: "wxid_other" },
    { message_id: Number(event.message_id) },
    { sender: { user_id: "EnRomantice" } },
    { sender_wxid: "wxid_different" },
    { group_id: "wxid_fakegroup" },
  ]) {
    assert.equal(normalizeInbound({ ...event, ...patch }, "wxid_bot"), null);
  }
});
test("textual @ and @all never synthesize a personal mention", () => {
  const normalized = normalizeInbound(
    {
      ...event,
      message: [
        { type: "text", data: { text: "@iriva2026 hi" } },
        { type: "at", data: { qq: "all" } },
      ],
    },
    "wxid_bot",
  );
  assert.deepEqual(normalized?.mentions, []);
});
test("bubble splitter retains grapheme clusters and exact content across punctuation and long paragraphs", () => {
  const text = ("家人👨‍👩‍👧‍👦 e\u0301🇨🇳。\n" + "问题".repeat(180)).repeat(3);
  const bubbles = splitBubbles(text, 35);
  assert.equal(bubbles.join(""), text);
  assert.ok(bubbles.every((part) => graphemes(part).length <= 35));
  assert.deepEqual(graphemes(bubbles.join("")), graphemes(text));
  assert.throws(() => splitBubbles("x", 0));
});
test("delay grows with length, jitter bounded, cap enforced", () => {
  const settings = {
    baseDelayMs: 100,
    perGraphemeMs: 10,
    jitterMs: 20,
    maxDelayMs: 1000,
  };
  assert.equal(
    bubbleDelay("abc", settings, () => 0),
    110,
  );
  assert.equal(
    bubbleDelay("abc", settings, () => 1),
    150,
  );
  assert.equal(
    bubbleDelay("x".repeat(1000), settings, () => 1),
    1000,
  );
});
test("outbox idempotency, serialized bubbles, and recipient authorization", async () => {
  const sent: string[] = [];
  const box = new BubbleOutbox(":memory:", {
    maxBubbleLength: 3,
    authorize: (d) => d.targetType === "group",
    sleep: async () => {},
    send: async (d) => {
      sent.push(d.text);
    },
  });
  assert.equal(
    box.enqueue({
      id: "one",
      targetType: "group",
      targetId: "g",
      text: "abcdef",
    }),
    true,
  );
  assert.equal(
    box.enqueue({
      id: "one",
      targetType: "group",
      targetId: "g",
      text: "different",
    }),
    false,
  );
  assert.throws(() =>
    box.enqueue({
      id: "evil",
      targetType: "admin",
      targetId: "stranger",
      text: "hi",
    }),
  );
  await Promise.all([box.drain(), box.drain()]);
  assert.deepEqual(sent, ["abc", "def"]);
  assert.ok(box.list().every((row) => row.status === "sent"));
  await box.close();
});
test("uncertain send blocks remaining recipient bubbles but other recipients continue", async () => {
  const calls: string[] = [];
  const box = new BubbleOutbox(":memory:", {
    maxBubbleLength: 3,
    authorize: () => true,
    sleep: async () => {},
    send: async (d) => {
      calls.push(d.targetId);
      if (d.targetId === "a") throw new Error("timeout after write");
    },
  });
  box.enqueue({ id: "a", targetType: "group", targetId: "a", text: "abcdef" });
  box.enqueue({ id: "b", targetType: "group", targetId: "b", text: "ok" });
  await box.drain();
  await box.drain();
  assert.deepEqual(calls, ["a", "b"]);
  assert.deepEqual(
    box.list().map((x) => x.status),
    ["uncertain", "pending", "sent"],
  );
  await box.close();
});
test("pre-dispatch failure retries at most three times", async () => {
  let calls = 0;
  const box = new BubbleOutbox(":memory:", {
    authorize: () => true,
    sleep: async () => {},
    send: async () => {
      calls++;
      throw new SafeRetryError("offline");
    },
  });
  box.enqueue({ id: "a", targetType: "group", targetId: "a", text: "x" });
  await box.drain();
  await box.drain();
  assert.equal(calls, 3);
  assert.equal(box.list()[0]?.status, "failed");
  await box.close();
});
test("restart marks an in-flight send uncertain; no replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "iriva-outbox-"));
  const path = join(directory, "outbox.sqlite");
  let calls = 0;
  const options = {
    authorize: () => true,
    sleep: async () => {},
    send: async () => {
      calls++;
    },
  };
  try {
    const first = new BubbleOutbox(path, options);
    first.enqueue({
      id: "a",
      targetType: "group",
      targetId: "g",
      text: "hello",
    });
    await first.close();
    const db = new DatabaseSync(path);
    db.exec("UPDATE outbox SET status='sending'");
    db.close();
    const restarted = new BubbleOutbox(path, options);
    await restarted.drain();
    assert.equal(calls, 0);
    assert.equal(restarted.list()[0]?.status, "uncertain");
    await restarted.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("client refuses exposed bridge or unverified alias", () => {
  const defaults = {
    token: "test",
    accountId: "wxid_bot",
    onMessage: () => {},
  };
  assert.throws(
    () => new OneBotClient({ ...defaults, baseUrl: "http://example.com" }),
  );
  assert.throws(
    () =>
      new OneBotClient({
        ...defaults,
        baseUrl: "http://127.0.0.1:58080",
        accountId: "iriva2026",
      }),
  );
});
test("mock bridge verifies account, receives structured events and sends authenticated group/admin HTTP", async () => {
  const requests: { path: string | undefined; body: unknown }[] = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer test");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    requests.push({
      path: request.url,
      body: JSON.parse(Buffer.concat(chunks).toString()) as unknown,
    });
    response.setHeader("Content-Type", "application/json");
    response.end('{"status":"ok"}');
  });
  const ws = new WebSocketServer({ server, path: "/ws" });
  ws.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, "Bearer test");
    socket.on("message", (bytes) => {
      const query = JSON.parse(bytes.toString()) as {
        action: string;
        echo: string;
      };
      socket.send(
        JSON.stringify({
          status: "ok",
          echo: query.echo,
          data: { user_id: "wxid_bot" },
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let readyResolve!: () => void;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  let receivedResolve!: () => void;
  const received = new Promise<void>((resolve) => {
    receivedResolve = resolve;
  });
  const observed: string[] = [];
  const client = new OneBotClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: "test",
    accountId: "wxid_bot",
    onReady: readyResolve,
    onMessage: (message) => {
      observed.push(message.messageId);
      receivedResolve();
    },
  });
  try {
    await assert.rejects(
      client.sendGroup("123@chatroom", "before verified"),
      SafeRetryError,
    );
    client.start();
    await ready;
    for (const socket of ws.clients) {
      socket.send(JSON.stringify({ ...event, message_type: "private" }));
      socket.send(JSON.stringify(event));
    }
    await received;
    assert.deepEqual(observed, [event.message_id]);
    await client.sendGroup("123@chatroom", "reply");
    await client.sendAdmin("wxid_admin", "request");
    assert.equal(requests[0]?.path, "/send_group_msg");
    assert.deepEqual(requests[0]?.body, {
      group_id: "123@chatroom",
      message: [{ type: "text", data: { text: "reply" } }],
    });
    assert.equal(requests[1]?.path, "/send_private_msg");
  } finally {
    client.close();
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
