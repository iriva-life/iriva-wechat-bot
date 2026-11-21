import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync as realpath } from "node:fs";
import { StateStore } from "../src/policy/index.js";
import { applicationTools } from "../src/application.js";
import { runAdminBash } from "../src/admin-bash.js";
import type { AgentTask } from "../src/agents/index.js";

const task: AgentTask = {
  accountId: "wxid_bot",
  messageId: "m",
  groupId: "123@chatroom",
  senderId: "wxid_admin",
  text: "执行命令",
  role: "admin",
};
test("admin directory and Bash enforce verified identity, captured role and revocation before execution", async () => {
  for (const enabled of [true, false]) {
    const store = new StateStore(":memory:", {
      adminAliases: enabled ? ["EnRomantice"] : ["quietfire1"],
    });
    store.bindIdentity({
      alias: "EnRomantice",
      wxid: "wxid_admin",
      source: "manual",
      verified: true,
    });
    try {
      const tools = applicationTools(store, async () => ({}));
      const bash = tools.find((t) => t.name === "admin_bash")!;
      const list = tools.find((t) => t.name === "admin_knowledge_list")!;
      assert.deepEqual(bash.roles, ["admin"]);
      for (const invalid of [
        { ...task, senderId: "wxid_other" },
        { ...task, role: "other" as const },
        { ...task, role: "blocker" as const },
        ...(!enabled ? [task] : []),
      ]) {
        await assert.rejects(
          bash.execute({ command: "printf should-not-run" }, invalid),
          /Permission/,
        );
        await assert.rejects(list.execute({}, invalid), /Permission/);
      }
      if (enabled) {
        store.setDocument(task.senderId, "knowledge", "faq/start", "你好");
        store.setDocument(task.senderId, "knowledge", "ops/status", "ready");
        const rows = (await list.execute({ prefix: "faq/" }, task)) as any[];
        assert.equal(rows.length, 1);
        assert.equal(rows[0].key, "faq/start");
        assert.equal(rows[0].characters, 2);
        assert.equal("value" in rows[0], false);
        const result = (await bash.execute(
          { command: "printf admin-ok" },
          task,
        )) as any;
        assert.equal(result.output, "admin-ok");
        assert.equal(result.exitCode, 0);
      }
    } finally {
      store.close();
    }
  }
});
test("Bash preserves cwd and failure exit status without inheriting model credentials or BASH_ENV", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iriva-bash-"));
  const saved = {
    MODEL_API_KEY: process.env.MODEL_API_KEY,
    BASH_ENV: process.env.BASH_ENV,
  };
  process.env.MODEL_API_KEY = "test-private-key";
  process.env.BASH_ENV = "/does/not/exist";
  try {
    const r = await runAdminBash({
      command:
        'pwd; printf "key=%s env=%s" "$MODEL_API_KEY" "$BASH_ENV"; exit 7',
      cwd: dir,
    });
    assert.equal(r.exitCode, 7);
    assert.equal(r.output, `${realpath(dir)}\nkey= env=`);
    assert.equal(r.timedOut, false);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true });
  }
});
test("Bash kills a timed-out command tree and honors cancellation", async () => {
  const started = Date.now();
  const r = await runAdminBash({ command: "sleep 20 & wait", timeoutMs: 150 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 5000);
  const controller = new AbortController();
  const running = runAdminBash({ command: "sleep 20" }, controller.signal);
  controller.abort();
  assert.equal((await running).aborted, true);
});
test("Bash caps combined output", async () => {
  const r = await runAdminBash({ command: "yes x | head -c 100000" });
  assert.equal(r.truncated, true);
  assert.ok(r.output.length <= 16000);
});
