import { readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { StateStore } from "./policy/index.js";

// Trusted local operations over SSH. This CLI is never exposed as a model tool.
const [action, ...args] = process.argv.slice(2);
const configPath = resolve(process.env.IRIVA_CONFIG ?? "config/local.json");
if (action === "init") {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, readFileSync(resolve("config/example.json")), {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    "已生成配置，保持 dryRun=true；请先核验 bot/admin wxid 与群 ID。",
  );
} else if (action === "bind") {
  const [alias, wxid] = args;
  if (!alias || !/^wxid_[\w-]+$/.test(wxid ?? ""))
    throw new Error("用法：npm run admin -- bind <已核验微信号> <wxid>");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (
    ![config.botAlias, ...config.adminAliases].some(
      (a: string) => a.toLowerCase() === alias.toLowerCase(),
    )
  )
    throw new Error("该微信号不在本地配置中");
  const bindings = config.identityBindings as { alias: string; wxid: string }[];
  if (
    bindings.some(
      (b) =>
        (b.alias.toLowerCase() === alias.toLowerCase() && b.wxid !== wxid) ||
        (b.wxid === wxid && b.alias.toLowerCase() !== alias.toLowerCase()),
    )
  )
    throw new Error("绑定冲突，请人工核对");
  if (!bindings.some((b) => b.alias.toLowerCase() === alias.toLowerCase()))
    bindings.push({ alias, wxid });
  if (alias.toLowerCase() === config.botAlias.toLowerCase())
    config.botWxid = wxid;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  chmodSync(configPath, 0o600);
  console.log(
    "身份绑定已写入；重启后生效。此操作要求操作者已从可信资料核验微信号。",
  );
} else if (action === "status") {
  const c = JSON.parse(readFileSync(configPath, "utf8"));
  const state = new StateStore(
    resolve(process.env.IRIVA_DATA_DIR ?? "data", "policy.sqlite"),
    { adminAliases: c.adminAliases },
  );
  console.log(
    JSON.stringify(
      {
        botAlias: c.botAlias,
        botWxidConfigured: !!c.botWxid,
        dryRun: c.dryRun,
        groups: c.allowedGroupIds,
        unresolvedAdmins: c.adminAliases.filter(
          (a: string) =>
            !c.identityBindings.some(
              (b: { alias: string }) =>
                b.alias.toLowerCase() === a.toLowerCase(),
            ),
        ),
        pendingBlockRequests: state.listPendingRequests(),
      },
      null,
      2,
    ),
  );
  state.close();
} else {
  console.log("用法：npm run admin -- init | bind <微信号> <wxid> | status");
  process.exitCode = action ? 1 : 0;
}
