# IRIVA 微信群助手

Bot 微信号 `iriva2026`。管理员白名单为 `EnRomantice`、`quietfire1`。只在指定群被真正 @ 时回复；私聊输入、自己发出的消息、普通群消息和 blocker 消息全部忽略。主动私聊仅用于向管理员发送拉黑审核通知。

## 当前状态

应用实现和模拟端到端验证已完成。Mac mini 已部署程序及运行依赖，并从固定源码构建好 OneBot 桥接和暂存 Gadget，桥接自带测试通过。当前微信不是 bot，**未安装 Hook、未重签微信、未退出或切换账号、未启用常驻服务、未发送真实微信消息**。真实微信收发仍待测试。详细结果见 [验证记录](docs/VALIDATION.md)。

模型：OpenRouter `openai/gpt-5.6-luna`，Base URL `https://openrouter.ai/api/v1`。密钥在 Mac mini 项目根目录 `.env`（权限 0600），不提交源码。普通问题调用审核、工作、leader；工作工具调用可能增加模型轮次。

验证：本机和 Mac mini 均通过 31 项自动测试，含真实应用入口 + 三个子进程 + 模拟 OneBot/模型的完整链路。两台机器均通过真实 OpenRouter 验证了审核、实际知识工具调用和 leader 回复。Mac mini 的旧代理配置已更新为本机当前 Rustdesk-server 快照，代理重启后 OpenRouter/npm 连通性验证通过；准备脚本也支持相同 OS/CPU 的离线依赖同步。

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
| `src/inbox.ts` | 重复消息与结果不明任务的处理账本 |
| `src/main.ts` | 生命周期、单实例锁、接入和投递装配 |
| `config/example.json` | 公开配置模板，不含实际 wxid |
| `packages/` | 固定提交构建的 Wayline 包与来源说明 |
| `docs/macmini-bridge-runbook.md` | 微信桥接审计、构建、安装与还原手册 |

生产环境每个 agent 一个 OS 子进程、一个 Wayline Runtime、一个 SQLite 文件。所有实际任务先交 worker，leader 没有业务工具。reviewer 独立审核原始消息且无工具。每次提问独立创建会话，不混用不同群成员的历史；管理员可维护全局及当前群的预设上下文。

## 权限规则

- **admin**：公开微信号必须通过可信资料精确绑定内部 wxid。可使用全部已实现应用工具：知识库读写、上下文设置/清空、全局 prompt、全局行为设置、拉黑申请审批/拒绝、解除黑名单。不存在隐式 Shell 或任意文件访问能力。管理员名单和身份绑定只能在本地配置手动修改。
- **other**：默认角色。只获得 `knowledge_read`、`blocker_add_tools`；后者只能请求审核当前消息，不能指定他人、计次或直接拉黑。模型伪造工具调用也会被宿主权限校验拦截。
- **blocker**：入口直接忽略，不调用模型。
- 严重违规仅三类：明确窃取密钥/他人私密数据、绕过权限修改系统、破坏性操作。引用案例、正常讨论和一般拒绝不计次。审核输出必须包含原文精确证据；审核失败不计次。
- 同一个 bot/message ID 只计一次；第 **4** 次生成待审申请，带证据通知所有已绑定 admin。绑定缺失的通知保持待处理。任何 admin 可批准/拒绝，批准才生效，其他 admin 的过期通知取消。模型审核并非绝对准确，管理员负责最终复核。
- 管理员通知不能通过私聊回复处理；需在白名单群 @ bot 并提供申请 ID。公开群内不要粘贴私密证据，证据已在管理员通知中提供。
- `behavior/global` 当前支持 `paused` 和 `maxReplyChars`（100–8000）。暂停时 admin 仍能调整设置。全局 prompt 可改变回答行为，不能改变代码权限、私聊禁用和 @ 规则。

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

这些是占位示例，不能直接照抄。随后填写 `config/local.json` 的真实 `allowedGroupIds`。默认 `dryRun:true`：调用模型并验证流程，但只记录草稿长度，不投递微信。核验通过后才改 `dryRun:false` 并运行 `bash scripts/run-macmini.sh`。提供 LaunchAgent 示例但没有加载；激活前完成微信收发验收。

## 投递与恢复

默认每气泡最多 220 个 Unicode grapheme，优先按段落/标点拆分。每个气泡发送前等待约 `500ms + 字数×35ms ±250ms`，最高 12 秒，保持队列顺序。这是阅读节奏配置，不承诺规避平台限制。

入站去重和待发消息都持久化。发送前确认的连接错误最多尝试 3 次；发送后超时、异常或崩溃时标记 `uncertain`，冻结同一接收者后续气泡，需人工核查。HTTP `ok` 仅代表桥接确认，不证明接收者看到消息。不同接收者可以继续投递。

OneBot 只有一个 WS 客户端且没有可靠离线补发，不能同时开启上游 SwiftUI 自动回复 App。断线期间可能漏消息。单实例锁防止同一数据目录重复启动；异常退出后确认旧进程已停止，再人工清理 `data/host.lock`。不要自动清理锁或重放 `uncertain` 请求，因为管理员工具可能已执行。

## 微信上线验收

1. 确认登录 bot、自身 wxid、两个 admin 的 alias 映射，以及测试群 ID。
2. 对比两名群成员的发送者 ID；普通文字 `@昵称`、@别人、@所有人不触发。
3. 私聊不回复；真实 @ bot 正常问答；同一消息重放不重复回答。
4. other 无法改配置；两个 admin 均能管理应用；第四次经审核严重违规只申请、不自动拉黑。
5. 两个 admin 都收到申请；批准后 blocker 忽略；拒绝不拉黑；解除可恢复。
6. 分气泡顺序、长度节奏、断线、重启和不确定发送均按预期处理。

Hook 固定版本、签名修改、备份/回滚和 GPL-3.0 源码来源详见桥接手册。应用代码与上游 bridge 保持独立进程，本项目未改动 Wayline 核心。
