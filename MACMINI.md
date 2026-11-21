# Mac mini：微信登录与双击启动

## 日常使用

1. 打开 Mac mini 上的微信，登录 **iriva2026**，等待进入聊天列表。
2. 双击桌面的 **启动 IRIVA.command**。它是本仓库根目录同名脚本的软链接，更新代码后无需重新复制。
3. 看到 **已连接桥接** 才表示 bot 已连上 OneBot。终端会明确标出「演练模式」或「正式模式」。演练模式不发送消息。
4. 保持启动终端和微信运行。按 **Control+C** 停止本次 bot、子 agent 和桥接，微信本身继续运行。关机/退出登录后需再次启动；没有设置开机常驻。

本机已完成官方 App 备份、Hook 安装、bot/EnRomantice/群 ID 绑定和发送句柄初始化。quietfire1 已在白名单中，待真实通讯录自动匹配。真实私聊回复已由用户在手机确认收到，客户群未发送测试消息。桌面图标存在不代表所有验收项目已完成。脚本不会自动修改微信、授权管理员、猜测群 ID 或开启正式发送。

程序目录：`/Users/ender/.local/share/iriva-bot`。

## 远程登录 Mac mini

两台设备保持 Tailscale 在线。本机终端：

```bash
ssh macmini
```

操作微信界面请用 macOS 自带屏幕共享：

```bash
open 'vnc://100.89.24.34'
```

使用 Mac mini 的用户名 `ender` 和 Mac mini 登录密码。这里不需要另外建 SSH 转发。曾出现旧屏幕共享连接反复超时；退出屏幕共享客户端，再用上述完整地址新建连接后恢复。

## 手机确认成功，电脑仍回到登录页

2026-11-21 在未安装 Hook 的官方微信上复现。处理步骤：

1. 微信登录窗口右上角齿轮 → 网络代理设置，确认「使用代理」关闭。
2. Clash Verge 关闭 **虚拟网卡 / TUN 模式**，保留系统代理和本地 `127.0.0.1:7897` 代理服务。
3. 从微信菜单选择「退出微信」，重新打开，再点击登录并在手机确认；需要二维码时扫描新码。
4. 以电脑进入聊天列表为成功标准，不能只看手机上的登录状态。

这次关闭 TUN 并重启微信后成功进入聊天列表，微信连接恢复为实际局域网地址；OpenRouter 通过本地代理仍返回 HTTP 200。这是本机验证过的恢复流程，尚未通过单变量复现证明所有失败都由 TUN 引起。Clash 重启或切换配置可能重新开启 TUN，复发时先检查这个开关。启动脚本本身不会更改全局网络设置。

不要为此清空聊天数据或直接升级微信；当前桥接固定匹配 **4.1.15.55 / 270135**。

## 首次接入（一次性）

业务群：**IRIVA | 青鸟**，包含客户，不发送联调消息；测试群：**bot test**。两群均已加入白名单，仅真正 @ 时回复；真实收发联调使用测试群或管理员私聊。群名只供人工识别，程序必须使用实际 `数字@chatroom` ID。

1. 按 [桥接部署手册](docs/macmini-bridge-runbook.md) 检查官方签名、版本和构建产物，备份后退出微信，再安装 Hook。安装会修改并重新签名微信，并关闭其自动更新；不会关闭 SIP。
2. 重新打开微信并登录 bot。在只收不发配置下启动桥接，核验 bot 的真实 wxid、两位管理员公开微信号及业务群 ID。`get_login_info` 仅返回桥接配置值，不能独立证明登录身份。如果通讯录返回 `key_missing`，保持桥接运行，在微信「设置 → 账号与存储」退出登录再登录（不要退出微信进程），让 Hook 捕获登录初始化。
3. 在本地 `config/local.json` 写入 bot 绑定和群白名单。管理员公开微信号白名单为 `EnRomantice`、`quietfire1`；程序自动从可信通讯录匹配真实微信号，不需要逐个手动校验。缺失项保持待匹配，不阻塞上线；不能依据昵称、群名片或群消息自报身份授权。
4. 在本地 `.env` 增加 `IRIVA_IMAGE_PATH`，值为已核验 bot 数据目录下实际存在的 `xwechat_files/<bot账号目录>/temp` 路径，不能使用旧账号目录。保留模型及 OneBot 密钥在此文件，权限 `0600`。
5. 保持 `dryRun:true` 和 Hook `enableSend:"false"`，先验证真正 @ 的结构、成员 ID、管理员私聊直接处理、普通成员私聊忽略、群聊无 @ 忽略及草稿生成。
6. 仅在真实收发验收阶段启用 Hook 文本发送并改为 `dryRun:false`。保持发送排队关闭；微信每次重启后可能需要在自己的管理员私聊会话手动发送一条测试消息，供 Hook 捕获发送句柄。没有句柄时应明确失败，不能偷偷排队等待未来发送。

正式放行还需确认群内两名成员可区分、other 无管理员工具、第四次严重违规仅申请审批、两位管理员通知及气泡顺序。具体清单见 [README](README.md#微信上线验收)。

## 安装桌面入口与更新

在 Mac mini 项目目录执行一次：

```bash
cd /Users/ender/.local/share/iriva-bot
export PATH="$HOME/.local/bin:$PATH"
npm run build
bash scripts/install-desktop-link.sh
```

入口安装器遇到已有同名普通文件会停止，不覆盖用户文件。可在终端只执行启动检查，不启动桥接、不调用模型、不发消息：

```bash
"$HOME/.local/bin/node" --env-file=.env dist/scripts/desktop-launcher.js --check
```

本机开发目录更新部署用 `bash scripts/prepare-macmini.sh`；先在原启动终端按 Control+C 停止服务，再更新和重新双击。更新不会覆盖 `.env`、本地身份配置或运行数据。

## 日志、停止与故障

管理员可私聊 bot，或在白名单群真正 @ bot 后说：「列出知识库目录」「查看 faq/start」「把 faq/start 改成……」「用 Bash 执行 pwd」。知识库存储在 `data/policy.sqlite` 的 `policy_documents` 表，`kind=knowledge`。目录是条目的逻辑 key；`data/agents/` 存的是 agent 运行记录，不能当成知识库。可使用 `faq/start` 这样的分级名称。Bash 以 `ender` 主机权限运行，只有经过 wxid 核验的 admin 可调用；默认 30 秒、上限 60 秒，输出限长，不支持持续后台任务。普通成员没有 Bash 或知识库写入权限。

- 本机应用日志：`data/logs/bot.log`、`bot-stderr.log`、`bridge-stderr.log`。
- 桥接运行配置、媒体和日志：`~/Library/Application Support/IrivaBot/bridge/`。
- `desktop.lock` 表示桌面启动器实例；`host.lock` 表示应用实例。再次双击会停止检查并提示已有实例。
- 初始化前的失败消息可能在 outbox 中标为 `uncertain` 并挡住同一收件人的后续回复。先确认手机实际收件情况，备份数据库后人工核对；作废旧测试气泡可标为 `cancelled` 并保留审计，不能直接清空 inbox 或重放管理员工具。
- R3 接口成功表示已提交发送任务；Mac 微信可能不显示对应气泡，真实送达应以收件人的手机确认。
- 异常关机后若锁残留，先检查锁内 PID 是否仍属于原服务，核查 outbox 的 `uncertain` 记录及可能已执行的管理员工具，再人工处理锁。脚本不会自动删旧锁或重放消息。
- OneBot 只有一个 WS 消费者。不要同时运行上游 SwiftUI bot、调试 WS 客户端和本 bot。
- 上游桥接即使直接启动也会向 stdout 打印 token；本启动器丢弃该 stdout，诊断日志仅保留在受限的本机目录。不要复制完整进程参数或上传缓存/日志。token 仍可能被本机有权限查看进程参数的用户看到。
- 「已连接桥接」仅证明连接建立，不证明真实消息送达。正式验收要在手机端看到回复。联调使用管理员私聊，不向客户群发送测试消息。

本次官方 App 备份已校验：`~/Library/Application Support/IrivaBot/bridge/official-backup-20261121/`。还原签名、Gadget 和自动更新偏好请按桥接手册操作，不删除聊天数据库。


## 当前通过 SSH 后台启动的实例

这次部署使用同一个根目录入口在 SSH 后台启动，断开 SSH 后继续运行。日志在 `data/logs/desktop.log`；桌面入口会检测运行锁，避免重复启动。正常停止后再双击桌面图标即可转为终端前台运行：

```bash
cd /Users/ender/.local/share/iriva-bot
# 先确认该 PID 是本项目的 desktop-launcher.js，不是其他进程。
ps -p "$(cat data/desktop.lock/pid)" -o pid=,comm=
kill -TERM "$(cat data/desktop.lock/pid)"
```

等待 `data/desktop.lock` 和 `data/host.lock` 正常消失。不要在处理模型请求期间直接杀微信或删除锁。

## Context 与 worker

聊天记录和 memory 从本版本部署起保存在 `data/conversations.sqlite`。超过 100 条由后台 worker 压成 20 条，原始记录保留；回答与总结最多共用 5 个 worker。管理员说“查看 worker 状态”可查看实际进度，满载也可查询。完整规则见 [CONTEXT_MEMORY.md](CONTEXT_MEMORY.md)。
