# 验证记录 · 2026-11-21

## 应用

- 当前电脑：`npm run check` 通过，31 项测试、类型检查和构建全部通过。
- Mac mini：Node 24.21.0，`npm ls --depth=0` 正常，`npm run check` 同样全部通过。
- 完整模拟链路：真实 main 进程 → 模拟微信 WS → reviewer → worker 实际宿主工具调用 → leader → 延迟后的 HTTP 群回复；测试也覆盖私聊/无 @/重复消息静默及 SIGTERM 清理。
- 真实 OpenRouter：两台机器均完成 `openai/gpt-5.6-luna` 的审核、一次知识工具调用、leader 回答。使用合成问题与临时数据库，不连接微信，不读取真实聊天。
- 真实微信消息发送数量：0。Hook 未安装，微信仍在运行；签名校验有效，Frida Gadget load command 不存在。

## Mac mini 准备状态

- 应用：`/Users/ender/.local/share/iriva-bot`。
- Node：复用 `/Users/ender/.local/bin/node`，没有修改系统 Node。
- `.env` 与 `config/local.json` 权限均为 0600；密钥只存在受限运行配置，不在源码、文档或测试数据中。
- `dryRun=true`，bot wxid 未填写，群白名单为空；初始 admin 为 EnRomantice、quietfire1，均待可信 wxid 绑定。
- 未加载 bot LaunchAgent、未启动真实微信监听、未退出/重签/切换微信账号。

## 微信桥接构建

- 固定源码提交：`d823148abfb0524edce256b9b3749d99f4160b6b`，位于 Mac mini 项目 `vendor/wechat-bridge/`；源码工作区保持未修改。
- Go 1.25.14、Frida devkit 17.8.0 和 Gadget 均按固定 SHA256 校验通过。
- `vendor/wechat-bridge/bridge/onebot`：arm64，约 96 MB，自检通过；上游 Go 单元/接口契约测试通过（42.648 秒）。
- onebot SHA256：`10392e6505ab6473b80516517da7e9ba1553b9ff660049494e5847cd0f7c0a94`。
- 已暂存的 `hook/gadget/FridaGadget.dylib` SHA256：`d2a3453e3d011dd40fa0603638c557bd70d1d20c32f244bb2b840e6b59c0ea5e`。这是构建目录中的文件，没有装入微信。
- `hook/script.js` 与 `bridge/script.js` 一致。
- 记录：`/Users/ender/.local/share/iriva-bot/bridge-artifacts/` 内的 `SHA256SUMS`、`source-commit.txt`、`build-summary.txt`、构建日志和缓存路径。
- 构建后再次确认：微信官方签名仍有效，无 Gadget load command，onebot 未运行。

## 代理修复

用户授权同步本机选中的 Rustdesk-server。比对显示旧 Mac mini 节点与本机节点的服务器地址不同。

- 同步本机当前有效代理节点、分组及规则；保留 Mac mini 的监听端口、控制接口、密钥、DNS/TUN 等机器设置。
- 以本地配置快照保存为 `IrivaSyncedLocal` / `Rustdesk-server (本机同步)`，原 DigitalOcean 配置条目保留。
- Mihomo 配置校验通过，API 重载返回 HTTP 204；重启 Clash Verge 后当前配置仍为 `IrivaSyncedLocal`。
- 重启后 OpenRouter/npm HTTPS 连接正常，随后 Mac mini 真实模型 smoke 通过。
- 完整原配置备份：`/Users/ender/.local/share/iriva-bot/backups/clash-config-before-sync-20261121.tar.gz`，权限 0600，含代理敏感资料，请勿提交或公开。
- 此项是快照同步，不会自动跟随另一台电脑未来的订阅更新。回滚时可在 Clash Verge 选择保留的旧配置，或在退出应用后从备份恢复配置文件再启动。

## 上线前仍需完成

1. 用户将 Mac mini 微信切换为 iriva2026。
2. 核验 bot、两个管理员的真实内部 wxid，填写指定测试群 ID。
3. 按桥接手册备份/安装 Hook，完成真实群成员 ID、@ 收发与消息 ID 测试。
4. dry-run 验收后开启真实发送，再决定是否启用登录常驻。

测试通过代表程序和已验证接口链路成立，不代表已经完成真实微信端验收。
