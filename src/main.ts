import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadConfig } from "./config.js";
import { Inbox } from "./inbox.js";
import { StateStore } from "./policy/index.js";
import { BotApplication, applicationTools } from "./application.js";
import { ConversationStore } from "./conversation.js";
import { ConversationMaintenance } from "./conversation-maintenance.js";
import { WorkerJobs } from "./jobs.js";
import { record, isGroupId } from "./wechat/normalize.js";
import { bindDirectoryAdmins } from "./admin-directory.js";
import {
  createProcessAgentOrchestrator,
  type AgentTask,
} from "./agents/index.js";
import { OneBotClient, BubbleOutbox, type Delivery } from "./wechat/index.js";

process.umask(0o077);
const config = loadConfig();
const dataDir = resolve(process.env.IRIVA_DATA_DIR ?? "data");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const lock = join(dataDir, "host.lock");
try {
  mkdirSync(lock, { mode: 0o700 });
} catch {
  throw new Error(
    `已有进程锁 ${lock}。确认旧进程停止后再人工清理，不能并行运行同一数据目录。`,
  );
}
writeFileSync(join(lock, "pid"), String(process.pid));
let state: StateStore | undefined;
let inbox: Inbox | undefined;
let client: OneBotClient | undefined;
let outbox: BubbleOutbox | undefined;
let agents:
  | Awaited<ReturnType<typeof createProcessAgentOrchestrator>>
  | undefined;
const work = new Set<Promise<void>>();
const jobs = new WorkerJobs(5);
let conversations: ConversationStore | undefined;
let maintenance: ConversationMaintenance | undefined;
let stopping = false;
let timer: ReturnType<typeof setInterval> | undefined;
const log = (event: string, details: Record<string, unknown> = {}) =>
  console.log(
    JSON.stringify({ at: new Date().toISOString(), event, ...details }),
  );
// Never log provider errors/headers, message content, or tool arguments.
const report = () =>
  log("operation_failed", { action: "check_local_state_and_connection" });

async function cleanup() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  client?.close();
  const summaryStop = maintenance?.close();
  await Promise.allSettled(work);
  await summaryStop;
  await outbox?.close();
  await agents?.close();
  inbox?.close();
  state?.close();
  conversations?.close();
  rmSync(lock, { recursive: true, force: true });
}
try {
  state = new StateStore(join(dataDir, "policy.sqlite"), {
    adminAliases: config.adminAliases,
  });
  for (const b of config.identityBindings)
    state.bindIdentity({ ...b, source: "manual", verified: true });
  inbox = new Inbox(join(dataDir, "inbox.sqlite"));
  const db = state;
  conversations = new ConversationStore(join(dataDir, "conversations.sqlite"));
  let app: BotApplication;
  const reviewCurrent = async (task: Readonly<AgentTask>) => {
    if (db.roleFor(task.senderId) !== "other")
      throw new Error("Only current other request may be reviewed");
    const result = await agents!.review(task);
    if (
      result.severe &&
      result.category &&
      result.evidence &&
      task.text.includes(result.evidence)
    ) {
      db.recordReviewedIncident({
        accountId: task.accountId!,
        messageId: task.messageId,
        groupId: task.groupId,
        senderWxid: task.senderId,
        category: result.category,
        evidence: result.evidence,
        reviewer: "server-moderator",
        severity: "severe",
      });
      await app.notifyAdmins();
    }
    return { reviewed: true, severe: result.severe, automaticBlock: false };
  };
  const required = (key: string) => {
    const value = process.env[key];
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  };
  agents = await createProcessAgentOrchestrator({
    dataDir: join(dataDir, "agents"),
    modelConfig: {
      baseUrl: required("MODEL_BASE_URL"),
      apiKey: required("MODEL_API_KEY"),
      model: required("MODEL_ID"),
    },
    tools: applicationTools(db, reviewCurrent, { conversations, jobs }),
    onProgress: (task, stage, tool) => jobs.update(task.jobId, stage, tool),
    getGlobalPrompt: () =>
      db.getDocument("prompt", "global")?.value ??
      "你叫 IRIVA，通过微信私聊和群聊帮助大家解答问题。回复清晰、简洁。",
    getContext: (task) =>
      [
        db.getDocument("context", "global")?.value,
        db.getDocument("context", task.groupId)?.value,
        task.conversationContext ?? conversations!.contextFor(task),
      ]
        .filter(Boolean)
        .join("\n"),
  });
  const reconcile = () => {
    const rows = outbox!.list();
    for (const n of db.pendingNotifications()) {
      const relevant = rows.filter((r) => r.id.startsWith(`notice:${n.id}:`));
      if (relevant.length && relevant.every((r) => r.status === "sent"))
        db.markNotificationDelivered(n.id);
    }
  };
  const drain = async () => {
    if (config.dryRun || stopping) return;
    await outbox!.drain();
    reconcile();
  };
  const deliver = (d: Delivery) => {
    if (config.dryRun) {
      log("draft_generated", {
        targetType: d.targetType,
        characters: Array.from(d.text).length,
      });
      return;
    }
    outbox!.enqueue(d);
    void drain().catch(report);
  };
  app = new BotApplication({
    config,
    state: db,
    inbox,
    agents,
    deliver,
    conversations,
    jobs,
  });
  maintenance = new ConversationMaintenance(
    conversations,
    jobs,
    (task, snapshot) => agents!.summarize(task, snapshot),
    (success) =>
      log(success ? "context_compacted" : "context_compaction_deferred"),
  );
  let lastDirectoryAttempt = 0;
  const refreshAdmins = async () => {
    if (Date.now() - lastDirectoryAttempt < 60_000) return;
    lastDirectoryAttempt = Date.now();
    try {
      const directory = await client!.request("get_contact_directory");
      const groups = Object.entries(record(record(directory).groups))
        .filter(([id]) => isGroupId(id))
        .map(([id, value]) => ({
          id,
          name: String(
            record(value).display ??
              record(value).nickname ??
              record(value).name ??
              "",
          ),
        }));
      writeFileSync(
        join(dataDir, "groups.json"),
        JSON.stringify({ updatedAt: new Date().toISOString(), groups }),
        { mode: 0o600 },
      );
      const count = bindDirectoryAdmins(db, directory, config.botWxid);
      if (count) log("admin_directory_bound", { count });
    } catch {
      log("admin_directory_pending");
    }
  };
  client = new OneBotClient({
    baseUrl: required("ONEBOT_URL"),
    token: required("ONEBOT_TOKEN"),
    accountId: config.botWxid,
    onError: report,
    onReady: async () => {
      log("bridge_connected", { dryRun: config.dryRun });
      await refreshAdmins();
      await app.notifyAdmins();
      void drain().catch(report);
    },
    onMessage: (m) => {
      if (stopping) return;
      // Independent conversations run concurrently; admission is enforced by the shared five-slot pool.
      const operation = (async () => {
        if (
          m.conversationType === "private" ||
          (config.allowedGroupIds.includes(m.groupId) &&
            m.mentions.includes(config.botWxid))
        )
          void refreshAdmins().catch(report);
        if (!stopping) await app.process(m);
      })()
        .catch(report)
        .finally(() => {
          work.delete(operation);
          maintenance?.kick();
        });
      work.add(operation);
    },
  });
  outbox = new BubbleOutbox(join(dataDir, "outbox.sqlite"), {
    authorize: (d) =>
      d.targetType === "group"
        ? config.allowedGroupIds.includes(d.targetId)
        : d.targetType === "private"
          ? db.roleFor(d.targetId) === "admin"
          : db.roleFor(d.targetId) === "admin" &&
            db.mayDeliverNotification(d.id.split(":")[1] ?? "", d.targetId),
    send: (d) =>
      d.targetType === "group"
        ? client!.sendGroup(d.targetId, d.text)
        : d.targetType === "private"
          ? client!.sendPrivate(d.targetId, d.text)
          : client!.sendAdmin(d.targetId, d.text),
  });
  timer = setInterval(() => {
    void drain().catch(report);
    maintenance?.kick();
  }, 5000);
  process.once("SIGINT", () => {
    void cleanup().catch(report);
  });
  process.once("SIGTERM", () => {
    void cleanup().catch(report);
  });
  client.start();
  log("host_started", {
    botAlias: config.botAlias,
    dryRun: config.dryRun,
    groups: config.allowedGroupIds.length,
  });
} catch (error) {
  await cleanup();
  throw error;
}
