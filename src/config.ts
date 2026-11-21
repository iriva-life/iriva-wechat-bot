import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface IdentityBinding {
  alias: string;
  wxid: string;
}
export interface BotConfig {
  botAlias: string;
  botWxid: string;
  adminAliases: string[];
  allowedGroupIds: string[];
  identityBindings: IdentityBinding[];
  dryRun: boolean;
}

export function loadConfig(
  path = process.env.IRIVA_CONFIG ?? "config/local.json",
): BotConfig {
  const value: unknown = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (!value || typeof value !== "object")
    throw new Error("配置必须是 JSON 对象");
  const c = value as BotConfig;
  if (c.botAlias !== "iriva2026")
    throw new Error("本部署 botAlias 必须是 iriva2026");
  if (typeof c.botWxid !== "string" || !/^wxid_[\w-]+$/.test(c.botWxid))
    throw new Error("请填写经核验的 botWxid");
  for (const key of ["adminAliases", "allowedGroupIds"] as const) {
    if (
      !Array.isArray(c[key]) ||
      c[key].some((x) => typeof x !== "string" || !x.trim())
    )
      throw new Error(`${key} 必须是字符串数组`);
  }
  if (!c.adminAliases.length) throw new Error("至少配置一个 admin 微信号");
  c.adminAliases = c.adminAliases.map((a) => a.trim());
  if (c.adminAliases.some((a) => a.toLowerCase() === c.botAlias.toLowerCase()))
    throw new Error("Bot 自身不能作为管理员通知接收者");
  if (c.allowedGroupIds.some((id) => !/^\d+@chatroom$/.test(id)))
    throw new Error("只接受真实群 ID，不接受群名");
  if (!Array.isArray(c.identityBindings))
    throw new Error("identityBindings 必须是数组");
  const aliases = new Set<string>();
  const ids = new Set<string>();
  for (const b of c.identityBindings) {
    if (
      !b ||
      typeof b.alias !== "string" ||
      typeof b.wxid !== "string" ||
      !/^wxid_[\w-]+$/.test(b.wxid)
    )
      throw new Error("身份绑定无效");
    b.alias = b.alias.trim();
    if (!b.alias) throw new Error("微信号不能为空");
    if (aliases.has(b.alias.toLowerCase()) || ids.has(b.wxid))
      throw new Error("身份绑定存在重复或歧义");
    aliases.add(b.alias.toLowerCase());
    ids.add(b.wxid);
    if (
      b.wxid === c.botWxid &&
      b.alias.toLowerCase() !== c.botAlias.toLowerCase()
    )
      throw new Error("Bot wxid 不能绑定给其他微信号");
  }
  if (typeof c.dryRun !== "boolean")
    throw new Error("dryRun 必须显式设置 true/false");
  if (!c.dryRun && !c.allowedGroupIds.length) {
    throw new Error("正式运行需配置群白名单");
  }
  return c;
}
