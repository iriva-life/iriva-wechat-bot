import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explicitAddressing } from "../src/addressing.js";
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

test("addressing uses explicit preferred name and does not infer third-party identity", () => {
  assert.equal(explicitAddressing("他说叫我小王", true), undefined);
  assert.equal(
    explicitAddressing("叫我小张就好，介绍一下IRIVA", false)?.name,
    "小张",
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
    assert.equal(store.addressingFor(t).asked, true);
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


test("directory nicknames follow wxid and account, refresh without overwriting explicit preferences", () => {
  const store = new ConversationStore(":memory:");
  const t = task("name", "叫我小张");
  const context = (input = t) => JSON.parse(store.contextFor(input));
  try {
    assert.deepEqual(context().senderProfile, {});
    store.updateContactDirectory(t.accountId!, { users: {
      wxid_a: { nickname: "小蓝 🌿", remark: "秘密备注", display: "秘密备注" },
      wxid_b: { nickname: "另一个人" },
      wxid_c: { remark: "只有备注", alias: "alias" },
      wxid_bad: { nickname: "bad\nname" },
    } });
    assert.equal(context().senderProfile.nickname, "小蓝 🌿");
    assert.equal(context({ ...t, groupId: "456@chatroom" }).senderProfile.nickname, "小蓝 🌿");
    assert.equal(context({ ...t, senderId: "wxid_b" }).senderProfile.nickname, "另一个人");
    assert.deepEqual(context({ ...t, senderId: "wxid_c" }).senderProfile, {});
    assert.deepEqual(context({ ...t, senderId: "wxid_bad" }).senderProfile, {});
    assert.deepEqual(context({ ...t, accountId: "wxid_otherbot" }).senderProfile, {});
    assert.doesNotMatch(store.contextFor(t), /秘密备注|另一个人/);
    record(store, t);
    store.observeAddressing(t);
    store.updateContactDirectory(t.accountId!, { users: { wxid_a: { nickname: "新昵称" } } });
    assert.equal(context().senderProfile.nickname, "新昵称");
    assert.equal(context().addressing.name, "小张");
    store.updateContactDirectory(t.accountId!, { groups: {} });
    assert.equal(context().senderProfile.nickname, "新昵称");
    store.updateContactDirectory(t.accountId!, { users: {} });
    assert.deepEqual(context().senderProfile, {});
    assert.equal(context().addressing.name, "小张");
  } finally { store.close(); }
});
