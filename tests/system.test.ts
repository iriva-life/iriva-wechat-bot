import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { DatabaseSync } from "node:sqlite";

interface ModelBody {
  messages: { role: string; content?: string; tool_call_id?: string }[];
  tools?: { function: { name: string } }[];
}
interface SentBody {
  group_id?: string;
  user_id?: string;
  message: { type: string; data: { text: string } }[];
}
async function until(
  check: () => boolean,
  description: string,
  timeoutMs = 15_000,
) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`Timed out: ${description}`);
    await delay(20);
  }
}

test(
  "full main entrypoint: bridge → reviewer → worker tool → leader → paced group/private send; ignored inputs and replay remain silent",
  { timeout: 35_000 },
  async () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const directory = mkdtempSync(join(tmpdir(), "iriva-system-"));
    const dataDir = join(directory, "data");
    const configPath = join(directory, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        botAlias: "iriva2026",
        botWxid: "wxid_bot",
        adminAliases: ["EnRomantice", "quietfire1"],
        identityBindings: [
          { alias: "EnRomantice", wxid: "wxid_admin_a" },
          { alias: "quietfire1", wxid: "wxid_admin_b" },
        ],
        allowedGroupIds: ["123@chatroom"],
        dryRun: false,
      }),
    );
    const models: ModelBody[] = [];
    const sent: SentBody[] = [];
    const roles: string[] = [];
    const failures: unknown[] = [];
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
        response.setHeader("Content-Type", "application/json");
        if (request.url === "/v1/chat/completions") {
          assert.equal(request.headers.authorization, "Bearer mock-model-key");
          const model = body as ModelBody;
          models.push(model);
          const system = model.messages
            .filter((m) => m.role === "system")
            .map((m) => m.content ?? "")
            .join("\n");
          if (!system.includes("独立的违规审核")) {
            const input = JSON.parse(
              model.messages.find((m) => m.role === "user")!.content!,
            );
            if (input.question === "分别是什么内容？") {
              assert.match(input.context, /二加二等于四/);
              assert.match(input.context, /二加二等于几/);
              assert.doesNotMatch(input.context, /普通群消息/);
            }
          }
          let message: Record<string, unknown>;
          if (system.includes("独立的违规审核")) {
            roles.push("reviewer");
            assert.equal(model.tools, undefined);
            message = {
              role: "assistant",
              content: JSON.stringify({
                severe: false,
                category: null,
                evidence: "",
                reason: "ordinary question",
              }),
            };
          } else if (system.includes("你是 IRIVA 的工作子 agent")) {
            assert.match(system, /当前提问者角色：other/);
            const names = model.tools?.map((t) => t.function.name) ?? [];
            assert.ok(names.includes("knowledge_read"));
            assert.ok(names.includes("blocker_add_tools"));
            assert.equal(
              names.some((name) => name.startsWith("admin_")),
              false,
            );
            const toolResult = model.messages.find((m) => m.role === "tool");
            if (!toolResult) {
              roles.push("worker-tool");
              message = {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "read-public-knowledge",
                    type: "function",
                    function: { name: "knowledge_read", arguments: "{}" },
                  },
                ],
              };
            } else {
              roles.push("worker-result");
              assert.equal(toolResult.tool_call_id, "read-public-knowledge");
              assert.ok(toolResult.content?.includes("[]"));
              message = {
                role: "assistant",
                content: "知识库暂无资料。基础事实：二加二等于四。",
              };
            }
          } else {
            assert.ok(system.includes("leader"));
            assert.match(system, /当前提问者角色：other/);
            assert.match(system, /微信消息必须使用纯文本/);
            roles.push("leader");
            assert.equal(model.tools, undefined);
            assert.ok(
              model.messages.some((m) => m.content?.includes("知识库暂无资料")),
            );
            message = { role: "assistant", content: "**二加二等于四。**" };
          }
          response.end(JSON.stringify({ choices: [{ message }] }));
        } else if (
          ["/send_group_msg", "/send_private_msg"].includes(request.url ?? "")
        ) {
          assert.equal(
            request.headers.authorization,
            "Bearer mock-bridge-token",
          );
          sent.push(body as SentBody);
          response.end('{"status":"ok"}');
        } else {
          throw new Error(`Unexpected outgoing request: ${request.url}`);
        }
      } catch (error) {
        failures.push(error);
        response.statusCode = 500;
        response.end('{"status":"failed"}');
      }
    });
    const sockets = new WebSocketServer({ server, path: "/ws" });
    sockets.on("connection", (socket, request) => {
      try {
        assert.equal(request.headers.authorization, "Bearer mock-bridge-token");
      } catch (e) {
        failures.push(e);
      }
      socket.on("message", (bytes) => {
        const command = JSON.parse(bytes.toString()) as {
          action: string;
          echo: string;
        };
        if (command.action !== "get_login_info") {
          failures.push(new Error("Unexpected WS action"));
          return;
        }
        socket.send(
          JSON.stringify({
            status: "ok",
            echo: command.echo,
            data: { user_id: "wxid_bot" },
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve(root, "src/main.ts")],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          IRIVA_CONFIG: configPath,
          IRIVA_DATA_DIR: dataDir,
          MODEL_BASE_URL: `${url}/v1`,
          MODEL_API_KEY: "mock-model-key",
          MODEL_ID: "mock-model",
          ONEBOT_URL: url,
          ONEBOT_TOKEN: "mock-bridge-token",
        },
      },
    );
    let output = "",
      errors = "";
    let exit:
      | { code: number | null; signal: NodeJS.Signals | null }
      | undefined;
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      errors += String(chunk);
    });
    const exited = new Promise<void>((resolveExit) => {
      child.once("exit", (code, signal) => {
        exit = { code, signal };
        resolveExit();
      });
    });
    child.on("error", (error) => {
      failures.push(error);
    });
    const emit = (event: Record<string, unknown>) => {
      for (const socket of sockets.clients) socket.send(JSON.stringify(event));
    };
    const base = {
      post_type: "message",
      message_type: "group",
      self_id: "wxid_bot",
      group_id: "123@chatroom",
      sender: { user_id: "wxid_other" },
      user_id: "wxid_other",
      message_id: "100000000000000001",
      message: [
        { type: "text", data: { text: "二加二等于几？" } },
        { type: "at", data: { qq: "wxid_bot" } },
      ],
    };
    try {
      await until(
        () => output.includes("bridge_connected") || !!exit,
        "verified bridge connection",
      );
      assert.equal(exit, undefined, `Host exited before ready: ${errors}`);
      emit({ ...base, message_id: "self-1", is_self: true });
      emit({
        ...base,
        message_id: "unmentioned-1",
        message: [
          {
            type: "text",
            data: { text: "@iriva2026 普通文字，不是真正的提及" },
          },
        ],
      });
      await delay(200);
      assert.equal(models.length, 0);
      assert.equal(sent.length, 0);
      emit(base);
      await until(
        () => sent.length === 1 || failures.length > 0 || !!exit,
        "group answer",
      );
      assert.deepEqual(failures, []);
      assert.equal(exit, undefined, errors);
      assert.deepEqual(roles, [
        "reviewer",
        "worker-tool",
        "worker-result",
        "leader",
      ]);
      assert.deepEqual(sent, [
        {
          group_id: "123@chatroom",
          message: [{ type: "text", data: { text: "二加二等于四。" } }],
        },
      ]);
      emit(base);
      emit({ ...base, message_id: "self-2", is_self: true });
      emit({
        ...base,
        message_id: "unmentioned-2",
        message: [{ type: "text", data: { text: "普通群消息" } }],
      });
      await delay(300);
      assert.equal(models.length, 4);
      assert.equal(sent.length, 1);
      emit({
        ...base,
        message_id: "private-3",
        message_type: "private",
        group_id: undefined,
        message: [{ type: "text", data: { text: "二加二等于几？" } }],
      });
      await until(
        () => sent.length === 2 || failures.length > 0,
        "private answer",
      );
      assert.deepEqual(failures, []);
      assert.equal((sent[1] as SentBody).user_id, "wxid_other");
      assert.equal(sent[1].group_id, undefined);
      assert.equal(models.length, 8);
      emit({
        ...base,
        message_id: "private-followup",
        message_type: "private",
        group_id: undefined,
        message: [{ type: "text", data: { text: "分别是什么内容？" } }],
      });
      await until(
        () => sent.length === 3 || failures.length > 0,
        "contextual follow-up",
      );
      assert.deepEqual(failures, []);
      assert.equal(models.length, 12);
      child.kill("SIGTERM");
      await until(() => !!exit, "graceful SIGTERM shutdown", 8000);
      await exited;
      const completed = exit as
        | { code: number | null; signal: NodeJS.Signals | null }
        | undefined;
      assert.equal(completed?.code, 0, errors);
      assert.equal(completed?.signal, null);
      assert.equal(existsSync(join(dataDir, "host.lock")), false);
      const outbox = new DatabaseSync(join(dataDir, "outbox.sqlite"));
      try {
        assert.deepEqual(
          outbox
            .prepare("SELECT status FROM outbox")
            .all()
            .map((r) => r.status),
          ["sent", "sent", "sent"],
        );
      } finally {
        outbox.close();
      }
      for (const name of [
        "worker-1",
        "worker-2",
        "worker-3",
        "worker-4",
        "worker-5",
        "leader",
        "reviewer",
      ])
        assert.ok(existsSync(join(dataDir, "agents", `${name}.sqlite`)));
    } finally {
      if (!exit) {
        child.kill("SIGTERM");
        await Promise.race([exited, delay(8000)]);
        if (!exit) {
          child.kill("SIGKILL");
          await exited;
        }
      }
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolveClose) =>
        sockets.close(() => resolveClose()),
      );
      server.closeAllConnections();
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
