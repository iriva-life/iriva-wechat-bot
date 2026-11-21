# 验证记录 · 2026-11-21

## 应用

- 当前电脑：`npm run check` 通过，47 项测试、类型检查和构建全部通过。
- Mac mini：Node 24.21.0，`npm ls --depth=0` 正常，`npm run check` 同样全部通过。
- 完整模拟链路：真实 main 进程 → 模拟微信 WS → reviewer → worker 实际宿主工具调用 → leader → 延迟后的 HTTP 群回复；测试也覆盖私聊正常回复、群聊无 @/重复消息静默及 SIGTERM 清理。
- 真实 OpenRouter：两台机器均完成 `openai/gpt-5.6-luna` 的审核、一次知识工具调用、leader 回答。使用合成问题与临时数据库，不连接微信，不读取真实聊天。
- 管理员新增知识库目录工具与 Bash 工具，覆盖真实身份授权、角色伪造/撤权拒绝、超时取消、输出上限及进程环境隔离测试。
- 真实私聊：管理员入站消息已触发 Bash；修正知识库路径说明后，worker 实际调用 admin_bash（退出码 0）和 admin_knowledge_list（0 条），leader 生成回答，通过正式 outbox 投递；用户已在手机确认收到。手动初始化消息 1 条，bot 回答 1 条，客户群测试消息 0 条。
- 初始化前失败的旧消息阻塞后续投递；已先备份 outbox，再将 4 个过时测试气泡标为 cancelled 并保留审计记录。未清空 inbox，也未重放管理员变更命令。知识库路径修正后的只读验收单独执行并入队。
- 官方 App 已备份并校验 ZIP，Gadget 已安装，修改后签名验证通过并保留 sandbox entitlement。

## Mac mini 准备状态

- 应用：`/Users/ender/.local/share/iriva-bot`。
- Node：复用 `/Users/ender/.local/bin/node`，没有修改系统 Node。
- `.env` 与 `config/local.json` 权限均为 0600；密钥只存在受限运行配置，不在源码、文档或测试数据中。
- `dryRun=false`，bot 身份已通过微信个人资料和活动数据库目录核验并绑定；「IRIVA | 青鸟」真实群 ID 已配置。EnRomantice 已由真实通讯录 alias 绑定；quietfire1 在白名单中，待通讯录自动匹配，不阻塞启动。
- 桌面 `启动 IRIVA.command` 软链接已安装；未加载 LaunchAgent。正式主 bot 和桥接已运行，记录 `host_started`、`bridge_connected`。发送配置已启用 R3 文本发送，首次发送句柄初始化已完成，真实私聊回复由用户在手机确认收到。

## 微信桥接构建

- 固定源码提交：`d823148abfb0524edce256b9b3749d99f4160b6b`，位于 Mac mini 项目 `vendor/wechat-bridge/`；源码工作区保持未修改。
- Go 1.25.14、Frida devkit 17.8.0 和 Gadget 均按固定 SHA256 校验通过。
- `vendor/wechat-bridge/bridge/onebot`：arm64，约 96 MB，自检通过；上游 Go 单元/接口契约测试通过（42.648 秒）。
- onebot SHA256：`10392e6505ab6473b80516517da7e9ba1553b9ff660049494e5847cd0f7c0a94`。
- 已暂存的 `hook/gadget/FridaGadget.dylib` SHA256：`d2a3453e3d011dd40fa0603638c557bd70d1d20c32f244bb2b840e6b59c0ea5e`。已安装到微信，并通过 load command 检查。
- `hook/script.js` 与 `bridge/script.js` 一致。
- 记录：`/Users/ender/.local/share/iriva-bot/bridge-artifacts/` 内的 `SHA256SUMS`、`source-commit.txt`、`build-summary.txt`、构建日志和缓存路径。
- 安装前官方 Tencent 签名已核验；完整官方 App 与原签名、自动更新偏好已保存在 `~/Library/Application Support/IrivaBot/bridge/official-backup-20261121/`。安装后为重新签名的微信。

## 代理修复

用户授权同步本机选中的 Rustdesk-server。比对显示旧 Mac mini 节点与本机节点的服务器地址不同。

- 同步本机当前有效代理节点、分组及规则；保留 Mac mini 的监听端口、控制接口、密钥、DNS/TUN 等机器设置。
- 以本地配置快照保存为 `IrivaSyncedLocal` / `Rustdesk-server (本机同步)`，原 DigitalOcean 配置条目保留。
- Mihomo 配置校验通过，API 重载返回 HTTP 204；重启 Clash Verge 后当前配置仍为 `IrivaSyncedLocal`。
- 重启后 OpenRouter/npm HTTPS 连接正常，随后 Mac mini 真实模型 smoke 通过。
- 完整原配置备份：`/Users/ender/.local/share/iriva-bot/backups/clash-config-before-sync-20261121.tar.gz`，权限 0600，含代理敏感资料，请勿提交或公开。
- 此项是快照同步，不会自动跟随另一台电脑未来的订阅更新。回滚时可在 Clash Verge 选择保留的旧配置，或在退出应用后从备份恢复配置文件再启动。

## 微信登录恢复

官方未修改客户端同样出现手机确认后电脑返回登录页。关闭 Mihomo 运行时 TUN、保留系统代理并重启微信后，用户进入聊天列表；OpenRouter 代理访问仍为 HTTP 200。此时只修改了运行时 TUN，重启 Clash 后需重新检查。详情见根目录 [MACMINI.md](../MACMINI.md)。

## 尚未验证的范围

1. quietfire1 的真实微信号出现于通讯录后由程序自动匹配。
2. 群聊 @ 结构与成员区分仍需在无客户的测试群验证；不在客户群发送测试消息。
3. 是否启用登录常驻另行决定。

私聊文字收发和管理员只读 Bash/知识目录已完成真机验证；真实群聊、多管理员审批及知识库变更尚未进行真机验收。R3 的 HTTP 成功只表示提交到微信发送通道，不能单独当成手机送达证明。

## 纯文本与权限说明修复

- worker、leader 的模型请求均携带宿主判定的角色及可委派工具；覆盖 admin 身份与自报 admin 的 other 身份隔离。
- 发送前转换常见 Markdown，保留 Bash 操作符、路径、URL 和正文；模拟完整主进程链路验证模型返回加粗内容时，私聊/群聊出口仍为纯文本。

## Context、memory、并行与 ACP

- 自动验证 101→20、并发到达消息保留、第二轮压缩、失败不丢历史、重启恢复、原始记录去重。
- 验证个人/群 memory 的来源证据、实际提及筛选、私聊和群之间及不同群之间的隔离。
- 5 个真实 worker 子进程通过 ACP 同时执行工具并同步进度，第 6 项被拒绝；独立结果不会串任务。
- 满载时管理员可直接查所有 worker，普通成员不能使用该控制通道。
- 完整 main 模拟链路新增连续追问，确认 worker 和 leader 都拿到此前问答，私聊不会混入群历史。

- Mac mini 同样通过 47 项检查；真实 OpenRouter 连续问“有哪些知识库 key？”和“分别是什么内容？”正确返回三项 FAQ，实际执行 4 次只读知识工具并收到 8 次 ACP 工具更新。
- 真实模型将 101 条合成记录总结为恰好 20 条，并成功写入隔离的验收数据库；验收未发送微信消息。
