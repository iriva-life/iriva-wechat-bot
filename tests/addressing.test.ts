import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explicitAddressing, addressReply } from "../src/addressing.js";
import { ConversationStore } from "../src/conversation.js";
import type { AgentTask } from "../src/agents/index.js";
const task = (
  messageId: string,
  text: string,
  patch: Partial<AgentTask> = {},
): AgentTask => ({
  accountId: "wxid_bot",
  senderId: "wxid_a",
  groupId: "123@chatroom",
  messageId,
  text,
  role: "other",
  mentions: [],
  ...patch,
});
function record(store: ConversationStore, t: AgentTask) {
  store.recordInbound({
    ...t,
    accountId: t.accountId!,
    mentions: [...(t.mentions ?? [])],
    conversationType: t.groupId.startsWith("private:") ? "private" : "group",
    isSelf: false,
  });
}

test("addressing asks once, uses explicit preferred name and does not infer third-party identity", () => {
  assert.equal(explicitAddressing("他说叫我小王", true), undefined);
  assert.equal(
    explicitAddressing("叫我小张就好，介绍一下IRIVA", false)?.name,
    "小张",
  );
  assert.equal(
    addressReply("内容", { refused: false, asked: false }).asked,
    true,
  );
  assert.equal(
    addressReply("内容", { refused: false, asked: true }).text,
    "你好，内容",
  );
  assert.equal(
    addressReply("内容", { name: "小张", refused: false, asked: true }).text,
    "小张，内容",
  );
  assert.equal(
    addressReply("小张，内容", { name: "小张", refused: false, asked: true })
      .text,
    "小张，内容",
  );
});

test("personal address and refusal survive restart and compaction; refusal applies to future conversations", () => {
  const dir = mkdtempSync(join(tmpdir(), "iriva-address-")),
    path = join(dir, "conversation.sqlite");
  let store = new ConversationStore(path);
  try {
    let t = task("first", "你好");
    record(store, t);
    store.markAddressingAsked(t);
    t = task("refuse", "不方便透露称呼");
    record(store, t);
    store.observeAddressing(t);
    assert.equal(store.addressingFor(t).refused, true);
    assert.equal(addressReply("内容", store.addressingFor(t)).asked, false);
    store.close();
    store = new ConversationStore(path);
    assert.equal(
      store.addressingFor({ ...t, groupId: "456@chatroom" }).refused,
      true,
    );
    assert.equal(
      store.addressingFor({ ...t, senderId: "wxid_b" }).refused,
      false,
    );
    t = task("name", "以后叫我小张");
    record(store, t);
    store.observeAddressing(t);
    assert.equal(store.addressingFor(t).name, "小张");
    const snapshot = store.snapshot("wxid_bot", "123@chatroom");
    store.applySummary(snapshot, {
      summaries: Array.from({ length: 20 }, (_, i) => `摘要${i}`),
      memories: [],
    });
    assert.equal(store.addressingFor(t).name, "小张");
    assert.equal(
      store.addressingFor({ ...t, groupId: "456@chatroom" }).name,
      undefined,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("address tools cannot invent a name from quotes, another person's evidence or a question", () => {
  const store = new ConversationStore(":memory:");
  try {
    const t = task("quote", "他说叫我小王");
    record(store, t);
    assert.throws(() => store.setAddressing(t, "小王", false, t.text));
    const self = task("self", "叫我小张");
    record(store, self);
    assert.throws(() =>
      store.setAddressing(
        { ...self, senderId: "wxid_b" },
        "小张",
        false,
        self.text,
      ),
    );
    store.markAddressingAsked(self);
    const question = task("price", "多少钱");
    record(store, question);
    assert.throws(() =>
      store.setAddressing(question, "多少钱", false, question.text),
    );
    const name = task("short", "小李");
    record(store, name);
    store.setAddressing(name, "小李", false, "小李");
    assert.equal(store.addressingFor(name).name, "小李");
  } finally {
    store.close();
  }
});
