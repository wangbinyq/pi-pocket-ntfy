# pi-pocket-ntfy

用 ntfy 主题取代微信，直接和 Pi Pocket 的 **Pi in Pocket（PiP）** 会话对话。

消息从 ntfy 主题进来，转成 PiP 的一次输入；PiP 的最终回复自动发回同一个主题。只有一个会话，不做切换。

## 与 pi-pocket-weixin 的区别

| | pi-pocket-weixin | pi-pocket-ntfy |
| --- | --- | --- |
| 传输 | 微信 iLink（扫码登录） | ntfy 主题（HTTP + 访问令牌） |
| 会话 | 多会话路由、`/sessions` `/resume` `/new` | 只有 PiP，固定会话 |
| 控制命令 | `/stop` `/model` `/busy` `/send` | 无 |
| 输入中提示 | 有 | 无（ntfy 没有这个能力） |
| 依赖 | proper-lockfile、qrcode、zod | 无运行时依赖 |

审批仍然在 Pocket 网页完成，两个桥接都不通过聊天批准危险操作。

## 要求

- Node.js 24 以上（用到原生类型剥离、`fetch`）。
- 一个可访问的 Pi Pocket，启用 PiP。
- 一个 ntfy 服务器和主题。服务器开启鉴权时，需要一个能读写该主题的访问令牌。

## 快速开始

```sh
git clone https://github.com/wangbinyq/pi-pocket-ntfy.git
cd pi-pocket-ntfy
cp .env.example .env
chmod 600 .env
```

编辑 `.env`：

```dotenv
POCKET_URL=http://127.0.0.1:8080
POCKET_TOKEN=你的Pocket-owner-token
NTFY_URL=https://ntfy.example.com
NTFY_TOPIC=pip
NTFY_TOKEN=tk_xxxxxxxxxxxxxxxx
```

```sh
node --env-file=.env src/cli.ts doctor   # 检查 Pocket 认证、PiP、ntfy 发布
node --env-file=.env src/cli.ts start    # 前台运行
```

## systemd

```ini
[Unit]
Description=ntfy bridge for the Pi in Pocket session
After=pi-pocket.service

[Service]
Type=exec
WorkingDirectory=/path/to/pi-pocket-ntfy
EnvironmentFile=%h/.config/pi-pocket-ntfy/bridge.env
ExecStart=/usr/bin/node /path/to/pi-pocket-ntfy/src/cli.ts start
Restart=on-failure
RestartSec=10
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
```

## 两个主题，用途不同

| 主题 | 方向 | 谁用 |
| --- | --- | --- |
| `pip` | 双向 | 桥接和 PiP 之间的对话 |
| `pip-notify` | 单向，只推给你 | 任何会话/脚本给主人发通知 |

往 `pip` 里发消息等于给 PiP 下指令；要提醒主人不要发到 `pip`。

## notify 命令

`bin/notify` 往 `pip-notify` 推一条消息，任何会话都能用：

```sh
notify -t "部署完成" "main 分支 已上线，耗时 3m12s"
notify "只有正文"
notify "标题" "正文"
```

配置从 `~/.config/pi-pocket-ntfy/notify.env` 读，权限 600：

```dotenv
NTFY_URL=https://ntfy.example.com
NTFY_TOPIC=pip-notify
NTFY_TOKEN=tk_xxxxxxxxxxxxxxxx
```

也可以用同名的环境变量覆盖。装法：

```sh
ln -sf "$PWD/bin/notify" ~/.local/bin/notify
```

## Skill

`skills/ntfy/SKILL.md` 让 agent 在合适的时机自己想起这条通道（任务结束、构建失败、定时任务需要人看）。装法是文件级软链，仓库是唯一来源：

```sh
mkdir -p ~/.agents/skills/ntfy
ln -sf "$PWD/skills/ntfy/SKILL.md" ~/.agents/skills/ntfy/SKILL.md
```

新会话启动时 Pi 会扫描 `~/.agents/skills/`，把每个 skill 的名称和描述放进系统提示，命中时才加载正文。它不改 AGENTS.md，也不改变未命中时的行为。

## 行为

- **输入**：主题里的普通消息原文提交给 PiP，`requestId` 用 ntfy 消息 ID，所以重放是幂等的。
- **附件**：消息带附件时先下载（上限 20 MiB），上传到 Pocket 再提交；纯附件消息正文用「请看附件。」。
- **输出**：只发 PiP 的最终回复；工具调用中间态、思考过程、工具日志都不发。
- **分片**：超过 `NTFY_CHUNK_LIMIT`（默认 3000 字）按段落和代码块切分，代码块会闭合后再续。
- **回声**：桥接自己发布的消息会从同一个主题流回来，发布和接收共用一把互斥量，先把发出的消息 ID 记下再判断，所以不会回环。
- **恢复**：游标和已发消息 ID 存在 `~/.local/share/pi-pocket-ntfy/state.json`，重启后从最后一条消息继续，不重放旧内容。

## 不支持

`/stop`、`/model`、会话切换、输入中提示、审批确认、语音、视频。

## 安全

- `.env` 里是 owner token，权限 600，不要提交。
- 主题名不是密码。用 ntfy 的 `auth-default-access: deny-all` 加访问令牌，否则任何知道主题名的人都能给 PiP 下指令。
- 桥接只和 PiP 会话通信，不接受远程会话 ID。
