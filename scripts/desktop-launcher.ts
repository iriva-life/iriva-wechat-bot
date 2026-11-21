import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  openSync,
  closeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../src/config.js";

process.umask(0o077);
const checkOnly = process.argv.includes("--check");
const root = process.cwd();
const state = join(homedir(), "Library/Application Support/IrivaBot/bridge");
const data = resolve(process.env.IRIVA_DATA_DIR ?? "data");
const lock = join(data, "desktop.lock");
const logDir = join(data, "logs");
let ownsLock = false;
let bridge: ChildProcess | undefined;
let bot: ChildProcess | undefined;
let stopping = false;
let cleanupPromise: Promise<void> | undefined;
const logFds: number[] = [];

function command(file: string, args: string[]): string {
  const r = spawnSync(file, args, { encoding: "utf8", timeout: 15_000 });
  if (r.status !== 0) return "";
  return r.stdout;
}
async function listening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createConnection({ host: "127.0.0.1", port });
    const finish = (ok: boolean) => {
      s.destroy();
      done(ok);
    };
    s.setTimeout(1000, () => finish(false));
    s.once("connect", () => finish(true));
    s.once("error", () => finish(false));
  });
}
async function stopChild(child?: ChildProcess) {
  if (!child?.pid) return;
  // Each service owns its process group, including worker descendants.
  const signal = (value: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, value);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + 90_000;
  while (
    child.exitCode === null &&
    child.signalCode === null &&
    Date.now() < deadline
  )
    await delay(200);
  if (child.exitCode === null && child.signalCode === null) {
    console.error(
      "服务退出超时，强制结束本次进程组；下次启动前请检查锁和不确定投递记录。",
    );
    signal("SIGKILL");
    await delay(300);
  }
  // Also remove any orphan descendants after an unexpected parent exit.
  signal("SIGTERM");
}
function cleanup() {
  return (cleanupPromise ??= (async () => {
    stopping = true;
    await stopChild(bot);
    await stopChild(bridge);
    bot?.stdout?.removeAllListeners("data");
    for (const fd of logFds) closeSync(fd);
    if (ownsLock) rmSync(lock, { recursive: true });
  })());
}
function privateLog(name: string) {
  const fd = openSync(join(logDir, name), "a", 0o600);
  logFds.push(fd);
  return fd;
}

try {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("启动入口仅适用于 Apple Silicon Mac。");
  console.log("IRIVA 微信群助手 — 启动检查");
  if (existsSync(lock) || existsSync(join(data, "host.lock")))
    throw new Error(
      "已有运行锁。若已启动，请使用原终端；异常退出请按 MACMINI.md 检查，不要重复启动或直接删锁。",
    );
  const config = loadConfig();
  if (!config.allowedGroupIds.length)
    throw new Error("尚未核验测试群 ID，请先完成 MACMINI.md 的首次接入。");
  if (
    !config.identityBindings.some(
      (b) => b.alias === config.botAlias && b.wxid === config.botWxid,
    )
  )
    throw new Error("缺少已核验的 bot 身份绑定。");
  for (const name of [
    "MODEL_API_KEY",
    "MODEL_BASE_URL",
    "MODEL_ID",
    "ONEBOT_TOKEN",
  ]) {
    if (!process.env[name]) throw new Error(`缺少本机配置 ${name}。`);
  }
  if (process.env.ONEBOT_URL !== "http://127.0.0.1:58080")
    throw new Error("桌面启动器要求 ONEBOT_URL=http://127.0.0.1:58080。");
  if (process.env.ONEBOT_TOKEN === "MuseBot")
    throw new Error("请使用随机 OneBot token。");
  const imagePath = process.env.IRIVA_IMAGE_PATH;
  const accountDir = imagePath?.match(
    /\/xwechat_files\/(wxid_[\w-]+_[a-f\d]{4})\/temp(?:\/|$)/,
  )?.[1];
  if (
    !imagePath ||
    !existsSync(imagePath) ||
    !accountDir ||
    accountDir.slice(0, -5) !== config.botWxid
  )
    throw new Error("IRIVA_IMAGE_PATH 未配置或不属于已核验 bot。");
  const plist = "/Applications/WeChat.app/Contents/Info.plist";
  if (
    command("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :WeChatBundleVersion",
      plist,
    ]).trim() !== "4.1.15.55" ||
    command("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleVersion",
      plist,
    ]).trim() !== "270135"
  )
    throw new Error("微信版本不匹配，停止加载 Hook；请看 MACMINI.md。");
  const binary = join(root, "vendor/wechat-bridge/bridge/onebot");
  if (!existsSync(binary)) throw new Error("缺少 OneBot 桥接构建产物。");
  const deps = command("/usr/bin/otool", [
    "-L",
    "/Applications/WeChat.app/Contents/MacOS/WeChat",
  ]);
  if (!deps.includes("FridaGadget.dylib"))
    throw new Error(
      "微信 Hook 尚未安装；桌面入口不会自行修改微信，先完成首次接入。",
    );
  const hookPath = join(state, "hook.json");
  const hook = JSON.parse(readFileSync(hookPath, "utf8"));
  if (
    !config.dryRun &&
    (hook.enableSend !== "true" ||
      hook.req2bufSendMode !== "r3" ||
      hook.r3QueueUntilSeed !== "false")
  )
    throw new Error("正式发送配置未完成验收。");
  if (
    [
      "r3QueueUntilSeed",
      "r3VoiceSend",
      "r3AppMsgSend",
      "r3PatSend",
      "snsEnable",
      "snsWrite",
    ].some((k) => hook[k] !== "false")
  )
    throw new Error("Hook 应保持额外发送能力和延迟排队关闭。");
  const pids = command("/usr/bin/pgrep", ["-x", "WeChat"])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (pids.length !== 1)
    throw new Error("请先打开微信并登录 iriva2026，进入聊天列表后再双击启动。");
  const files = command("/usr/sbin/lsof", ["-nP", "-p", pids[0], "-Fn"]);
  const activeAccounts = new Set(
    [
      ...files.matchAll(
        /\/xwechat_files\/(wxid_[\w-]+_[a-f\d]{4})\/db_storage\//g,
      ),
    ].map((m) => m[1]),
  );
  if (activeAccounts.size !== 1 || !activeAccounts.has(accountDir))
    throw new Error(
      "无法确认当前微信打开的是已绑定 bot 数据库；请完成登录或检查是否切换了账号。",
    );
  if (!(await listening(27042)))
    throw new Error("微信 Gadget 未就绪，请重启已安装 Hook 的微信并登录。");
  if (await listening(58080))
    throw new Error(
      "桥接端口已占用。请先停止原启动窗口，避免抢占 OneBot 连接。",
    );
  console.log(
    `检查通过：${config.dryRun ? "演练模式（不发送消息）" : "正式模式"}，白名单群 ${config.allowedGroupIds.length} 个。`,
  );
  if (!checkOnly) {
    mkdirSync(data, { recursive: true, mode: 0o700 });
    mkdirSync(lock, { mode: 0o700 });
    ownsLock = true;
    writeFileSync(join(lock, "pid"), String(process.pid));
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(state, "logs"), { recursive: true, mode: 0o700 });
    mkdirSync(join(state, "media"), { recursive: true, mode: 0o700 });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
      process.once(signal, () => {
        void cleanup();
      });
    bridge = spawn(
      binary,
      [
        "-type=gadget",
        "-gadget_addr=127.0.0.1:27042",
        `-wechat_conf=${hookPath}`,
        "-receive_host=127.0.0.1:58080",
        "-conn_type=websocket",
        `-token=${process.env.ONEBOT_TOKEN}`,
        `-self_id=${config.botWxid}`,
        `-image_path=${imagePath}`,
        `-media_dir=${join(state, "media")}`,
        `-log_file=${join(state, "logs/bridge.log")}`,
        "-log_level=warn",
        "-send_interval=100",
      ],
      {
        cwd: join(root, "vendor/wechat-bridge/bridge"),
        detached: true,
        // Upstream prints the token at startup on stdout; deliberately discard it.
        stdio: ["ignore", "ignore", privateLog("bridge-stderr.log")],
      },
    );
    let launchError = false;
    bridge.on("error", () => {
      launchError = true;
    });
    const deadline = Date.now() + 30_000;
    while (!stopping && !(await listening(58080))) {
      if (
        launchError ||
        bridge.exitCode !== null ||
        bridge.signalCode !== null ||
        Date.now() > deadline
      )
        throw new Error(
          "桥接未就绪，详情保存在本机 data/logs/bridge-stderr.log。",
        );
      await delay(300);
    }
    if (!stopping) {
      bot = spawn(process.execPath, ["dist/src/main.js"], {
        cwd: root,
        detached: true,
        stdio: ["ignore", "pipe", privateLog("bot-stderr.log")],
      });
      const fd = privateLog("bot.log");
      let ready = false;
      let buffer = "";
      bot.on("error", () => {
        launchError = true;
      });
      bot.stdout!.on("data", (chunk: Buffer) => {
        writeFileSync(fd, chunk);
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          try {
            const event = JSON.parse(line).event;
            if (event === "bridge_connected" && !ready) {
              ready = true;
              console.log(
                "已连接桥接。保持此终端开启；按 Control+C 停止 bot 和桥接。微信本身会继续运行。",
              );
              console.log(
                config.dryRun
                  ? "当前只生成草稿，不会回复微信。"
                  : "仅管理员私聊直接回复；白名单群仅在被真正 @ 时回复。发送句柄仍需按手册初始化。",
              );
            }
            if (event === "operation_failed")
              console.error("运行出现错误，请检查本机日志及桥接连接。");
          } catch {
            /* Never echo arbitrary child output. */
          }
        }
      });
      const readyDeadline = Date.now() + 45_000;
      while (!stopping) {
        if (
          launchError ||
          bot.exitCode !== null ||
          bot.signalCode !== null ||
          bridge.exitCode !== null ||
          bridge.signalCode !== null
        )
          throw new Error(
            "bot 或桥接已退出，请查看本机 data/logs；本次服务将一并停止。",
          );
        if (!ready && Date.now() > readyDeadline)
          throw new Error("bot 连接超时，不能判定启动成功。");
        await delay(300);
      }
    }
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "启动失败，请检查本机配置。",
  );
  process.exitCode = 1;
} finally {
  await cleanup();
}
