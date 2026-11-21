# IRIVA 微信群助手

Bot 微信号 `iriva2026`。管理员白名单为 `EnRomantice`、`quietfire1`。仅管理员私聊直接回复；指定群只在被真正 @ 时回复。自己发出的消息、普通群消息和 blocker 消息忽略。两种会话共用管理员权限和违规规则；拉黑审核申请通过私聊通知管理员。

## 当前状态

应用实现和模拟端到端验证已完成。Mac mini 已部署程序及运行依赖，并从固定源码构建好 OneBot 桥接，桥接自带测试通过。2026-11-21 已通过远程桌面核验微信登录账号为 `iriva2026`，业务群为「IRIVA | 青鸟」。官方客户端备份已校验，Gadget 已安装，修改后的签名与 sandbox entitlement 检查通过。bot、EnRomantice 及业务群 ID 已核验绑定；quietfire1 保留白名单，待通讯录自动匹配。**bot 已在正式模式运行；管理员 Bash、知识目录和真实私聊回复已验证，用户已在手机确认收到。客户群未发送测试消息。** 详细结果见 [验证记录](docs/VALIDATION.md)。

**双击启动、SSH/远程桌面、微信登录失败恢复流程：[MACMINI.md](MACMINI.md)。** 根目录 `启动 IRIVA.command` 为桌面入口源文件，`scripts/install-desktop-link.sh` 在 Mac mini 桌面创建链接。

模型：OpenRouter `openai/gpt-5.6-luna`，Base URL `https://openrouter.ai/api/v1`。密钥在 Mac mini 项目根目录 `.env`（权限 0600），不提交源码。普通问题调用审核、工作、leader；工作工具调用可能增加模型轮次。

验证：本机和 Mac mini 均通过 47 项自动测试，含真实应用入口 + 五个 worker、leader 和 reviewer 子进程 + 模拟 OneBot/模型的完整链路。两台机器均通过真实 OpenRouter 验证了审核、实际知识工具调用和 leader 回复。Mac mini 的旧代理配置已更新为本机当前 Rustdesk-server 快照，代理重启后 OpenRouter/npm 连通性验证通过；准备脚本也支持相同 OS/CPU 的离线依赖同步。

## 架构与目录

```text
微信 Hook → OneBot WS → normalize → 群/@规则 → 去重账本
                                     ↓
                              reviewer 子进程
                                     ↓
                  worker 子进程（按身份授权工具）
                                     ↓
                  leader 子进程（零工具，仅组织回答）
                                     ↓
                 持久化 outbox → 分气泡/延迟 → OneBot HTTP
```

| 目录/文件 | 职责 |
|---|---|
| `src/wechat/` | 消息归一化、OneBot、Unicode 分气泡、发送队列 |
| `src/policy/` | wxid 权限、知识库/配置、违规记录、管理员审批 |
| `src/agents/` | Wayline 独立进程、工具 IPC、模型适配 |
| `src/application.ts` | 触发规则、业务工具、违规通知 |
| `src/conversation.ts` / `src/conversation-maintenance.ts` | 聊天历史、个人/群 memory、100→20 后台总结 |
| `src/jobs.ts` | 五槽并发、实际进度、管理员状态查询 |
| `src/inbox.ts` | 重复消息与结果不明任务的处理账本 |
| `src/main.ts` | 生命周期、单实例锁、接入和投递装配 |
| `config/example.json` | 公开配置模板，不含实际 wxid |
| `packages/` | 固定提交构建的 Wayline 包与来源说明 |
| `docs/macmini-bridge-runbook.md` | 微信桥接审计、构建、安装与还原手册 |

生产环境有 5 个 worker，回答与后台总结共用 5 个任务槽位；leader 只组织回答，reviewer 独立审核。每个进程使用 Wayline Runtime 和独立 SQLite，经 ACP v1 同步任务和工具进度。当前问题结合会话聊天记录和检索到的 memory，一同提供给 worker 和 leader。私聊按人隔离，群聊共享本群记录，跨来源记忆保持可见范围。活动记录超过 100 条后台压缩为 20 条，保留原始记录和总结期间的新消息。详见根目录 [CONTEXT_MEMORY.md](CONTEXT_MEMORY.md)。

## 人设与业务知识

根目录 [soul.md](soul.md) 定义 IRIVA 是一只青鸟，不自称“语言助手”。[knowledge/faq/](knowledge/faq/) 保存社区介绍、价格及差异三组问答，分别对应运行知识库的 `faq/about`、`faq/pricing`、`faq/difference`。

这些内容已同步到 Mac mini 的 `policy.sqlite`：人设对应 `prompt/global`，问答对应 `knowledge` 条目，后续请求即时生效。运行时以数据库为准；仅编辑或拉取仓库文件不会自动覆盖管理员在微信中修改的内容，更新文件后需显式同步。管理员可直接让 bot 查看或修改上述 key 和全局 prompt。

## 权限规则

- **admin**：公开微信号采用本地白名单；程序自动用可信微信通讯录的真实 `alias` 匹配内部 wxid，不要求逐个手工校验。尚未出现在通讯录的白名单项保持待匹配，不阻塞运行。可列出知识库目录、读取/修改条目、设置/清空上下文、修改全局 prompt/行为、审批/拒绝拉黑和解除黑名单；还可明确请求 `admin_bash`，以 Mac mini 的 `ender` 用户运行 Bash（默认 30 秒、最长 60 秒，输出最多 16000 字符）。Bash 是实际主机权限，不是沙盒，能够修改该用户可访问的文件；不注入模型密钥、OneBot token 或 BASH_ENV，不提供 sudo 密码。管理员名单从本机配置加载，身份绑定可来自本机配置或已鉴权桥接通讯录，不能靠修改全局 prompt 提权。
- **other**：默认角色。只获得 `knowledge_read`、当前会话可见的 `memory_read` / `memory_remember`、`blocker_add_tools`；后者只能请求审核当前消息，不能指定他人、计次或直接拉黑。模型伪造工具调用也会被宿主权限校验拦截。
- **blocker**：入口直接忽略，不调用模型。
- 严重违规仅三类：明确窃取密钥/他人私密数据、绕过权限修改系统、破坏性操作。引用案例、正常讨论和一般拒绝不计次。审核输出必须包含原文精确证据；审核失败不计次。
- 同一个 bot/message ID 只计一次；第 **4** 次生成待审申请，带证据通知所有已绑定 admin。绑定缺失的通知保持待处理。任何 admin 可批准/拒绝，批准才生效，其他 admin 的过期通知取消。模型审核并非绝对准确，管理员负责最终复核。
- 管理员可直接私聊处理通知，或在白名单群 @ bot 并提供申请 ID。公开群内不要粘贴私密证据，证据已在管理员通知中提供。
- `behavior/global` 当前支持 `paused` 和 `maxReplyChars`（100–8000）。暂停时 admin 仍能调整设置。全局 prompt 可改变回答行为，不能改变代码权限、群聊 @ 规则。

## 本地开发

要求 Node >=22.13，建议使用已验证 Node 24。依赖从锁文件安装：

```bash
npm ci --ignore-scripts
npm run check
npm run admin -- init
```

`npm run check` 执行类型检查、自动测试和构建，测试使用模拟微信/模型，绝不调用真实微信。`npm run smoke:model` 是显式真实模型检查（需要 `.env`，消耗少量 API 额度），使用临时数据、不连接微信。

## Mac mini 部署准备

程序目录：`/Users/ender/.local/share/iriva-bot`。
复用已安装 Node 24.21.0：`/Users/ender/.local/bin/node`。模型联网使用 Mac mini 已有的 `127.0.0.1:7897` 代理，`NO_PROXY` 排除本地 OneBot；这些设置仅在项目进程中生效。
SSH：`ssh macmini`（现有 Tailscale 配置）。更新：`bash scripts/prepare-macmini.sh`；不覆盖 `.env`、`data/`、`config/local.json`，不自动启动服务。

待切换 bot 后，先按桥接手册进行只读验证，从本人资料/可信通讯录核验真实 wxid。通讯录的 `alias` 可用于精确微信号匹配，`nickname`/群昵称不可用。`get_login_info` 是桥接配置/路径派生值，只能检查配置一致性，不能独立证明当前账号。

在 Mac mini 项目根目录，用真实值执行：

```bash
npm run admin -- bind iriva2026 wxid_BOT
npm run admin -- bind EnRomantice wxid_ADMIN1
npm run admin -- bind quietfire1 wxid_ADMIN2
```

这些是可选的人工绑定占位示例，不能直接照抄；管理员也会自动匹配真实通讯录微信号，缺失映射不会阻塞其他已识别管理员使用。随后填写 `config/local.json` 的真实 `allowedGroupIds`。默认 `dryRun:true`：调用模型并验证流程，但只记录草稿长度，不投递微信。核验通过后才改 `dryRun:false` 并运行 `bash scripts/run-macmini.sh`。提供 LaunchAgent 示例但没有加载；激活前完成微信收发验收。

## 投递与恢复

微信回复采用纯文本；leader 被明确要求不用 Markdown，发送前还会转换常见标题、加粗、列表、链接和代码围栏，命令正文保持原样。worker 与 leader 都收到宿主根据实际 wxid 判定的当前角色和可委派工具列表，查询权限时不会把 leader 自身没有工具误认为管理员没有权限。工具执行时继续校验最新权限。

默认每气泡最多 220 个 Unicode grapheme，优先按段落/标点拆分。每个气泡发送前等待约 `500ms + 字数×35ms ±250ms`，最高 12 秒，保持队列顺序。这是阅读节奏配置，不承诺规避平台限制。

入站去重和待发消息都持久化。发送前确认的连接错误最多尝试 3 次；发送后超时、异常或崩溃时标记 `uncertain`，冻结同一接收者后续气泡，需人工核查。HTTP `ok` 仅代表桥接确认，不证明接收者看到消息。不同接收者可以继续投递。

OneBot 只有一个 WS 客户端且没有可靠离线补发，不能同时开启上游 SwiftUI 自动回复 App。断线期间可能漏消息。单实例锁防止同一数据目录重复启动；异常退出后确认旧进程已停止，再人工清理 `data/host.lock`。不要自动清理锁或重放 `uncertain` 请求，因为管理员工具可能已执行。

## 微信上线验收

1. 确认登录 bot、自身 wxid、两个 admin 的 alias 映射，以及测试群 ID。
2. 对比两名群成员的发送者 ID；普通文字 `@昵称`、@别人、@所有人不触发。
3. 仅管理员私聊直接回复；群聊真实 @ bot 正常问答、无 @ 静默；同一消息重放不重复回答。
4. other 无法改配置；两个 admin 均能管理应用；第四次经审核严重违规只申请、不自动拉黑。
5. 两个 admin 都收到申请；批准后 blocker 忽略；拒绝不拉黑；解除可恢复。
6. 分气泡顺序、长度节奏、断线、重启和不确定发送均按预期处理。

Hook 固定版本、签名修改、备份/回滚和 GPL-3.0 源码来源详见桥接手册。应用代码与上游 bridge 保持独立进程，本项目未改动 Wayline 核心。
