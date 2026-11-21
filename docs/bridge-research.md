# 微信桥接调查与验证边界

调查日期：2026-11-21。没有安装 Hook，没有替用户发送微信消息。

## 选型

候选：[Gusion1017/WeChat-ChatBot-Mac](https://github.com/Gusion1017/WeChat-ChatBot-Mac)。只考虑其 Go OneBot + Frida Hook 桥接，不使用 SwiftUI 应用的 AI/规则/记忆模块。桥接是 GPL-3.0 项目；本项目通过本地协议对接，不复制其源码。

本机 SSH 检查的微信版本是 4.1.15.55，CFBundleVersion 270135；候选安装文档列出该版本的文本收发支持。没有完成真实账号端到端测试。Hook 修改微信应用并重签，有微信更新失效和账号风险；应先备份，精确核对版本与二进制。原作者最新版本的部分群 @ 能力也注明未逐项复测，不能将 README 的支持表视为本机验收。

源码依据：

- [hook/script.js](https://github.com/Gusion1017/WeChat-ChatBot-Mac/blob/main/hook/script.js)：读取群成员身份，解析 msgsource 的 `<atuserlist>`，输出 `sender_wxid`、`group_id`、`message_id`、`mentions` 和 `at` 消息段。
- [bridge/http.go](https://github.com/Gusion1017/WeChat-ChatBot-Mac/blob/main/bridge/http.go)：Bearer 鉴权；`POST /send_group_msg` 使用 `group_id`，`POST /send_private_msg` 使用 `user_id`，正文为 text 段数组。成功返回 status=ok；请求超时可能已有外部效果。
- [bridge/websocket.go](https://github.com/Gusion1017/WeChat-ChatBot-Mac/blob/main/bridge/websocket.go)：`/ws` 的 Header Bearer 鉴权；读动作 `get_login_info`、`get_contact_directory` 回传 echo/data；send_* 不提供可靠 echo，故只采用 HTTP 发送。
- [安装与版本说明](https://github.com/Gusion1017/WeChat-ChatBot-Mac/blob/main/docs/install.md)。

## 重要限制

1. 上游只接受一个 WebSocket 客户端。我们的 Host 与原作者 SwiftUI 应用不能同时连接桥接。
2. WebSocket 没有 durable cursor/replay 契约；断线期间事件可能丢失。重连并不保证补收。上线前必须测断线与恢复，不能承诺完全不丢消息。
3. `get_login_info` 的 selfID 来自桥接配置/目录推导，必须与管理员在本机核验的 bot wxid 一致。它不证明 `iriva2026` 微信号和 wxid 的绑定；此绑定需独立人工确认。
4. 通讯录名称/昵称不能作为 admin 白名单凭据。`EnRomantice`、`quietfire1` 必须可信映射到 wxid；无法验证则保持 other。
5. 本实现保守只接受 `wxid_*` 与 `*@openim` 用户身份。旧式账号内部 ID 若不是这种格式会被拒绝；需先用可信事件验证再显式扩展。
6. 发送 success 仅指桥接报告成功，不等于微信服务器送达证明。超时、5xx、重启时正在发送一律标记 uncertain，冻结同目标后续气泡，人工检查后才能决定处置。

## 本项目传输约定

- 只接收当前绑定账号的 group 事件，私聊和自身消息直接丢弃。
- 只使用结构化 mentions/at 段；文本 `@iriva2026` 不产生触发，`@all` 不视为 @bot。
- 消息 ID 保留字符串；JSON unsafe integer 拒绝，避免精度丢失造成去重冲突。
- `sendAdmin` 专供 Host 验证后的管理员通知，模型不直接获得此接口。Outbox 在入队和发送前均调用权限回调。
- 文本按 grapheme 分割，优先句末/段落边界；默认最多 220 字符簇一个气泡。延时默认 500ms + 每字符簇 35ms + ±250ms 随机误差，上限 12 秒，可配置。
- Outbox 是单进程单所有者 SQLite。成功/失败/uncertain 状态落盘，重启不盲目重发；只对明确未分发的 SafeRetryError 最多尝试三次。

## 上线验收

真实好友群中确认：两个同名成员 ID 不同；改昵称身份不变；真正 @bot 能触发而文本 @、@别人、@所有人不能；群自身消息不触发；私聊不调用模型；长回复气泡有序；HTTP 中断不重复回复；重启期间 in-flight 转 uncertain；两位 admin 均收到同一个拉黑申请通知；桥接重启后重新核验账号。所有对外测试发送需要在已指定测试群内进行。
