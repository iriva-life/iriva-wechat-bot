import { spawn } from "node:child_process";
import { resolve } from "node:path";

/** Authorization belongs to the host tool; never expose this as a built-in. */
export async function runAdminBash(
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  if (
    typeof args.command !== "string" ||
    !args.command.trim() ||
    args.command.length > 16_000
  )
    throw new Error("command 必须是 1..16000 字符的 Bash 命令");
  if (args.cwd !== undefined && typeof args.cwd !== "string")
    throw new Error("cwd 必须是路径字符串");
  const timeoutMs = args.timeoutMs ?? 30_000;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 60_000
  )
    throw new Error("timeoutMs 必须是 100..60000 的整数");
  signal?.throwIfAborted();
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "TMPDIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
  ])
    if (process.env[key]) env[key] = process.env[key];
  env.PATH = `${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  const secrets = [process.env.MODEL_API_KEY, process.env.ONEBOT_TOKEN].filter(
    (v): v is string => !!v,
  );
  const redact = (s: string) =>
    secrets.reduce((out, secret) => out.replaceAll(secret, "[REDACTED]"), s);
  return new Promise<{
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    aborted: boolean;
    truncated: boolean;
    output: string;
  }>((done, reject) => {
    const child = spawn(
      "/bin/bash",
      ["--noprofile", "--norc", "-c", args.command as string],
      {
        cwd: resolve((args.cwd as string) ?? process.cwd()),
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let timedOut = false,
      aborted = false,
      truncated = false;
    let output = Buffer.alloc(0);
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (value: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, value);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH") child.kill(value);
        }
      }
    };
    const stop = () => {
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 1000);
    };
    const abort = () => {
      aborted = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const collect = (chunk: Buffer) => {
      const room = 64 * 1024 - output.length;
      if (chunk.length > room) truncated = true;
      if (room > 0) output = Buffer.concat([output, chunk.subarray(0, room)]);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      kill("SIGKILL");
    };
    child.once("error", () => {
      cleanup();
      reject(new Error("Bash 启动失败，请检查工作目录及执行权限"));
    });
    child.once("close", (exitCode, exitSignal) => {
      cleanup();
      const clean = redact(output.toString("utf8"));
      done({
        exitCode,
        signal: exitSignal,
        timedOut,
        aborted,
        truncated: truncated || clean.length > 16_000,
        output: clean.slice(0, 16_000),
      });
    });
  });
}
