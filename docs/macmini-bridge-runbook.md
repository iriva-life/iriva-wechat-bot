# Mac mini 微信桥接部署手册

审计日期：2026-11-21。仅审阅源码，尚未完成本机真实收发验收。只部署 Hook + Go bridge，**不运行上游 SwiftUI 自动回复 App**，所有回复规则由本项目负责。

## 固定输入

- 上游：`https://github.com/Gusion1017/WeChat-ChatBot-Mac`
- 固定提交：`d823148abfb0524edce256b9b3749d99f4160b6b`
- 本地来源：`vendor/wechat-bridge`，GPL-3.0。保留上游 LICENSE、NOTICE 和提交来源。
- 目标：Apple Silicon，微信 **4.1.15.55 / 270135**；版本 JSON `hook/versions/4_1_15_55_mac.json`。
- bot 的公开微信号配置与真实内部 wxid 是两项；部署前确认当前登录账号确实是指定 bot。不得把公开微信号直接填入 `self_id`。
- SSH 只用于运维；安装会修改并重新签名微信，需退出微信，之后由用户登录。此手册没有自动执行这些动作。

## 已审阅的安装行为

`tools/manage_wechat.sh install` 会备份完整 App 和 entitlements，复制 Gadget，插入 load command，保留 sandbox entitlements 并 ad-hoc 重签主程序，去除原 hardened-runtime 签名标志；也会将微信 `SUEnableAutomaticChecks`、`SUAutomaticallyUpdate` 设为 false。它不关闭 SIP，不修改聊天数据库。

默认官方备份路径为 `~/Library/Application Support/WeChatAI/backups/WeChat-4.1.15.55-270135-official.zip`。建议通过 `--backup-dir` 指向本次专用目录，避免复用旧备份。脚本会检验 ZIP 可解压，但**不会证明已有备份是未注入的官方版本**；首次备份前必须检查签名来源及 Gadget 未安装，保存 App 可执行文件 SHA256。安装时 entitlements 为空会降级无 entitlements 签名，因此本流程先验证它非空再允许 install。

`restore` 会检验 ZIP 后删除当前 App 再解压；它不会恢复两项自动更新偏好，不清理 bridge 密钥/句柄缓存，也不改微信聊天数据。故备份、校验和偏好快照必须在操作前准备。

## 1. 只读预检

在 Mac mini 的项目根目录运行：

```bash
bash scripts/bridge-check.sh
git -C vendor/wechat-bridge rev-parse HEAD
xcrun --find clang
xcrun --show-sdk-path
```

必须匹配固定提交与版本，准备至少 5 GB 空间（构建缓存和 App 备份）。不要用 `--force` 或覆盖版本检查跳过不匹配。

## 2. 构建，不安装微信

上游脚本固定下载 Go 1.25.14、Frida devkit 17.8.0，验证固定 SHA256 后构建 `bridge/onebot` 并执行 Go 测试。Go modules 使用 go.sum 校验。Gadget 下载脚本验证压缩包和未签名 dylib 的 SHA256，再在本地 ad-hoc 签名。固定版本以外的 Gadget 会跳过 SHA 校验，**不要设置 FRIDA_GADGET_VERSION**。

已有大于 10 MB 的 Gadget 文件会跳过来源 SHA 校验；已解压的 Go/devkit 缓存也不会重新验证来源。因此使用私有的新缓存，确认 `hook/gadget/FridaGadget.dylib` 不存在或来源已经核验，不能盲目复用未知文件。

```bash
umask 077
export IRIVA_BRIDGE_SOURCE="$PWD/vendor/wechat-bridge"
export IRIVA_BRIDGE_STATE="$HOME/Library/Application Support/IrivaBot/bridge"
mkdir -p "$IRIVA_BRIDGE_STATE"
export BRIDGE_CACHE_DIR="$(mktemp -d "$IRIVA_BRIDGE_STATE/build-cache.XXXXXX")"
bash "$IRIVA_BRIDGE_SOURCE/scripts/build_bridge.sh"
bash "$IRIVA_BRIDGE_SOURCE/scripts/fetch_gadget.sh"
shasum -a 256 "$IRIVA_BRIDGE_SOURCE/bridge/onebot" "$IRIVA_BRIDGE_SOURCE/hook/gadget/FridaGadget.dylib" > "$IRIVA_BRIDGE_STATE/artifact-sha256.txt"
cmp "$IRIVA_BRIDGE_SOURCE/hook/script.js" "$IRIVA_BRIDGE_SOURCE/bridge/script.js"
```

构建脚本只修改源码产物/缓存；无需 Swift/Xcode App 构建。归档脚本打印的依赖校验结果和测试结果，不能把“源码构建成功”称为“微信收发通过”。

## 3. 备份、安装和还原

以下操作只能在确认当前账号及允许退出微信后进行；先让用户完全退出微信。保存两项更新偏好的原值（不存在也要记录），原签名描述和可执行文件哈希。只在未注入的官方 App 上创建新备份：

```bash
export WECHAT_SUPPORTED_VERSION=4.1.15.55
export WECHAT_SUPPORTED_BUILD=270135
export IRIVA_BACKUP_DIR="$IRIVA_BRIDGE_STATE/official-backup"
bash "$IRIVA_BRIDGE_SOURCE/tools/manage_wechat.sh" backup --backup-dir "$IRIVA_BACKUP_DIR"
unzip -tq "$IRIVA_BACKUP_DIR/WeChat-4.1.15.55-270135-official.zip"
test -s "$IRIVA_BACKUP_DIR/WeChat-4.1.15.55-270135-entitlements.plist"
plutil -lint "$IRIVA_BACKUP_DIR/WeChat-4.1.15.55-270135-entitlements.plist"
bash "$IRIVA_BRIDGE_SOURCE/tools/manage_wechat.sh" install --backup-dir "$IRIVA_BACKUP_DIR"
bash scripts/bridge-check.sh
```

恢复流程：先停 bot，再停 bridge，退出微信，核验备份 ZIP。随后运行 `manage_wechat.sh restore --backup-dir "$IRIVA_BACKUP_DIR"`，检查官方签名和 Gadget load command 消失，再按原快照恢复两项更新偏好。恢复操作本身会替换 App，不能在运行中的微信上执行。

## 4. 最小 bridge 进程

Gadget 配置固定监听 `127.0.0.1:27042`，加载时 resume。OneBot 只监听 `127.0.0.1:58080`，使用随机 Bearer token。不要使用上游默认 `MuseBot` token；不要把 token 写在仓库、日志或聊天中。上游 `run_bridge.sh` 会打印 token 或部分 token，并缺少显式 self_id 参数，本项目采用下面的直接进程启动方式。

在受保护的本地环境中设置 `IRIVA_BOT_WXID`、`IRIVA_IMAGE_PATH`、`IRIVA_ONEBOT_TOKEN`。`IRIVA_IMAGE_PATH` 必须来自当前 bot 对应的真实 `xwechat_files/<account>/temp` 目录，且与 wxid 匹配；不能随意选最近修改或第一个账号目录。

先复制版本配置到运行目录，保持 `enableSend="false"`、`req2bufSendMode="off"`。这是只收不发验证的实际开关；不要仅依赖 bridge 环境变量 `HOOK_SEND_DISABLED`，Hook 在微信进程中执行且其 `Process.env` 不保证可用。

```bash
cp "$IRIVA_BRIDGE_SOURCE/hook/versions/4_1_15_55_mac.json" "$IRIVA_BRIDGE_STATE/hook.json"
mkdir -p "$IRIVA_BRIDGE_STATE/logs" "$IRIVA_BRIDGE_STATE/media"
cd "$IRIVA_BRIDGE_SOURCE/bridge"
./onebot -type=gadget -gadget_addr=127.0.0.1:27042 \
  -wechat_conf="$IRIVA_BRIDGE_STATE/hook.json" \
  -receive_host=127.0.0.1:58080 -conn_type=websocket \
  -token="$IRIVA_ONEBOT_TOKEN" -self_id="$IRIVA_BOT_WXID" \
  -image_path="$IRIVA_IMAGE_PATH" -media_dir="$IRIVA_BRIDGE_STATE/media" \
  -log_file="$IRIVA_BRIDGE_STATE/logs/bridge.log" -log_level=warn -send_interval=100
```

注意上游仅提供 token 命令行参数，值对本机有权查看该进程参数的用户可见；不要在进程清单或故障报告中回显完整参数。工作目录必须是 `bridge/`，因为它从当前目录读取 `script.js`。

发送验收阶段才修改运行副本 JSON：`enableSend="true"`、`req2bufSendMode="r3"`、`r3ClosureCapture="true"`、`r3Slot13Capture="true"`；保持 `r3QueueUntilSeed="false"`，没有发送句柄时立即失败，避免未确认消息在未来自动发出。`r3VoiceSend`、`r3AppMsgSend`、`r3PatSend`、`snsEnable`、`snsWrite` 均保持 `"false"`。重启 bridge 后，需要用户在本机微信手动发送一条已确定的测试消息以捕获句柄；微信重启可能需要再次捕获。HTTP 成功还必须由测试接收端确认实际送达。

## 5. 身份与接口事实

- `get_login_info` 是 WS action；其 `data.user_id` **只是** `-self_id` 或 image_path 推导的 `myWechatId`，不能作为“当前登录账号已独立验证”的证据。
- `get_contact_directory` 是 WS action，返回 `data.users[wxid].alias`（公开微信号），以及 nickname/remark/display。只使用精确 alias 匹配管理员配置；后面三者不能授权。未找到或出现冲突时停止该管理员绑定。
- 群成员目录可有 wxid，但其 alias 可能为空。管理员需要先与 bot 成为联系人，或经本地人工核验后配置绑定；不允许群消息自报 alias 绑定。
- 公共目录响应经 `publicCopy()` 移除数据库密钥；不要直接调用 Hook 导出并记录完整结果。bridge 会把数据库密钥缓存到 `~/Library/Caches/WeChatAI/db-keys.json`（0600），发送句柄缓存到同目录 `r3-seed.json`。切号、卸载、备份策略需覆盖这些敏感文件；不能当普通日志上传。
- 入站读取 `group_id`、`sender.user_id`、`message_id`、`mentions` / `at` 段；发送调用带 Bearer 的 `POST /send_group_msg`，请求含 `group_id` 和消息段。管理员黑名单申请使用 `POST /send_private_msg`，普通私聊入站依旧忽略。
- 直接连接 `ws://127.0.0.1:58080/ws` 并用 Authorization header 鉴权；不要把 token 放查询参数或公开 Tailscale 端口。

## 6. 放行验收

未通过前保持 bot dry-run：当前 bot 身份；两名管理员 alias→wxid；两个群成员同名仍有不同 sender ID；真 @ bot 触发，普通 `@昵称` 文本、@其他人、@所有人及私聊不触发；去重；分气泡顺序；重启不重复发；第四次严重违规只生成请求；管理员批准后阻断，管理员解除后恢复。实际发消息前准备准确测试收件群和内容。

本手册没有执行 Hook 安装、重签、微信退出或真实发送。
