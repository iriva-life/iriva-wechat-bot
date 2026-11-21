import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConversationStore } from "../src/conversation.js";
import type { AgentTask } from "../src/agents/index.js";
import type { InboundMessage } from "../src/wechat/index.js";
import { WorkerJobs } from "../src/jobs.js";
import { ConversationMaintenance } from "../src/conversation-maintenance.js";
const m = (i: number, patch: Partial<InboundMessage> = {}): InboundMessage => ({
  accountId: "wxid_bot",
  senderId: "wxid_a",
  groupId: "private:wxid_a",
  conversationType: "private",
  messageId: String(i),
  text: `消息${i}`,
  isSelf: false,
  mentions: [],
  ...patch,
});
const task = (patch: Partial<AgentTask> = {}): AgentTask => ({
  accountId: "wxid_bot",
  senderId: "wxid_a",
  groupId: "private:wxid_a",
  messageId: "1",
  role: "other",
  text: "英语",
  ...patch,
});
const result = () => ({
  summaries: Array.from({ length: 20 }, (_, i) => `摘要${i}`),
  memories: [],
});

test("101 records compact to 20; preserve concurrent arrivals, archive and restart; repeat cycle", () => {
  const dir = mkdtempSync(join(tmpdir(), "iriva-context-")),
    path = join(dir, "context.sqlite");
  let store = new ConversationStore(path);
  try {
    for (let i = 1; i <= 100; i++) store.recordInbound(m(i));
    assert.equal(store.pendingSummaries().length, 0);
    store.recordInbound(m(101));
    assert.equal(store.pendingSummaries().length, 1);
    const before = store.snapshot("wxid_bot", "private:wxid_a");
    store.recordInbound(m(102));
    assert.equal(store.applySummary(before, result()), true);
    let current = store.snapshot("wxid_bot", "private:wxid_a");
    assert.equal(current.rows.length, 21);
    assert.equal(current.rows.at(-1)?.text, "消息102");
    assert.equal(store.applySummary(before, result()), false);
    store.close();
    store = new ConversationStore(path);
    assert.equal(store.snapshot("wxid_bot", "private:wxid_a").rows.length, 21);
    assert.equal(store.recordInbound(m(1)), false); // Raw archive dedup survives compression.
    for (let i = 103; i <= 182; i++) store.recordInbound(m(i));
    current = store.snapshot("wxid_bot", "private:wxid_a");
    assert.equal(current.rows.length, 101);
    assert.throws(() =>
      store.applySummary(current, { summaries: ["invalid"], memories: [] }),
    );
    store.applySummary(current, result());
    assert.equal(store.snapshot("wxid_bot", "private:wxid_a").rows.length, 20);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("private/group/person memories retain evidence and never leak across audiences", () => {
  const store = new ConversationStore(":memory:");
  try {
    store.recordInbound(m(1, { text: "我喜欢英语，记住这个偏好" }));
    store.remember(
      task({ text: "我喜欢英语，记住这个偏好" }),
      "喜欢英语",
      "我喜欢英语",
      "self",
    );
    assert.equal(store.memoriesFor(task()).length, 1);
    assert.equal(
      store.memoriesFor(
        task({
          senderId: "wxid_b",
          groupId: "private:wxid_b",
          mentions: ["wxid_a"],
        }),
      ).length,
      0,
    );
    assert.equal(
      store.memoriesFor(task({ groupId: "123@chatroom", mentions: ["wxid_a"] }))
        .length,
      0,
    );
    store.recordInbound(
      m(2, {
        groupId: "123@chatroom",
        conversationType: "group",
        text: "我想练口语；本群周六讨论",
      }),
    );
    const groupTask = task({
      messageId: "2",
      groupId: "123@chatroom",
      text: "我想练口语；本群周六讨论",
    });
    store.remember(groupTask, "想练口语", "我想练口语", "self");
    store.remember(groupTask, "周六讨论", "本群周六讨论", "group");
    assert.equal(
      store.memoriesFor(task({ senderId: "wxid_b", groupId: "123@chatroom" }))
        .length,
      1,
    );
    assert.equal(
      store.memoriesFor(
        task({
          senderId: "wxid_b",
          groupId: "123@chatroom",
          mentions: ["wxid_a"],
        }),
      ).length,
      2,
    );
    assert.equal(
      store.memoriesFor(task({ groupId: "456@chatroom", mentions: ["wxid_a"] }))
        .length,
      0,
    );
    assert.throws(() =>
      store.remember(task(), "伪造事实", "不存在的原文", "self"),
    );
    const snapshot = store.snapshot("wxid_bot", "123@chatroom");
    store.applySummary(snapshot, {
      ...result(),
      memories: [
        {
          ownerType: "user",
          ownerId: "wxid_b",
          value: "伪造别人的偏好",
          evidenceId: "in:wxid_bot:2",
          evidence: "我想练口语",
        },
      ],
    });
    assert.equal(
      store.memoriesFor(task({ senderId: "wxid_b", groupId: "123@chatroom" }))
        .length,
      1,
    );
  } finally {
    store.close();
  }
});

test("context combines earlier replies and memories without duplicating current request", () => {
  const store = new ConversationStore(":memory:");
  try {
    store.recordInbound(m(1, { text: "有哪些key" }));
    store.recordReply(
      task({ text: "有哪些key" }),
      "faq/about、faq/pricing、faq/difference",
    );
    store.recordInbound(m(2, { text: "分别是什么内容" }));
    const context = JSON.parse(
      store.contextFor(task({ messageId: "2", text: "分别是什么内容" })),
    );
    assert.equal(context.history.length, 2);
    assert.match(context.history[1].text, /faq\/pricing/);
    assert.equal(
      context.history.some((r: any) => r.text === "分别是什么内容"),
      false,
    );
  } finally {
    store.close();
  }
});

test("background summary shares five slots, defers while full, and retries without losing history", async () => {
  const store = new ConversationStore(":memory:"),
    jobs = new WorkerJobs();
  const leases = Array.from(
    { length: 5 },
    () => jobs.acquire({ senderId: "a", groupId: "b" }, "reply")!,
  );
  let calls = 0,
    resolve!: () => void;
  const gate = new Promise<void>((r) => (resolve = r));
  const maintenance = new ConversationMaintenance(store, jobs, async () => {
    calls++;
    await gate;
    return result();
  });
  try {
    for (let i = 1; i <= 101; i++) store.recordInbound(m(i));
    maintenance.kick();
    assert.equal(calls, 0);
    assert.equal(jobs.list().length, 5);
    leases[0].release();
    maintenance.kick();
    assert.equal(calls, 1);
    assert.equal(jobs.list().length, 5);
    maintenance.kick();
    assert.equal(calls, 1);
    resolve();
    await maintenance.close();
    assert.equal(store.snapshot("wxid_bot", "private:wxid_a").rows.length, 20);
  } finally {
    resolve();
    await maintenance.close();
    leases.forEach((l) => l.release());
    store.close();
  }
});

test("failed summaries preserve original history and back off; successful later run recovers", async () => {
  const store = new ConversationStore(":memory:"),
    jobs = new WorkerJobs();
  for (let i = 1; i <= 101; i++) store.recordInbound(m(i));
  let calls = 0;
  const first = new ConversationMaintenance(store, jobs, async () => {
    calls++;
    throw new Error("provider unavailable");
  });
  first.kick();
  await new Promise((r) => setImmediate(r));
  first.kick();
  assert.equal(calls, 1);
  assert.equal(jobs.list().length, 0);
  assert.equal(store.snapshot("wxid_bot", "private:wxid_a").rows.length, 101);
  await first.close();
  const recovered = new ConversationMaintenance(store, jobs, async () =>
    result(),
  );
  recovered.kick();
  await recovered.close();
  assert.equal(store.snapshot("wxid_bot", "private:wxid_a").rows.length, 20);
  store.close();
});
