---
name: ntfy
description: Send the owner a push notification on their phone through ntfy. Use when a long task finishes, a build or deploy fails, a scheduled job needs attention, or the owner asked to be told when something is done. Also covers the two topics (`pip` reaches the Pi in Pocket assistant, `pip-notify` is one-way to the owner) and the `notify` command.
allowed-tools: Bash(notify:*), Bash(curl:*), Read
---

# ntfy notifications

The owner reads ntfy on a phone. One command sends a notification.

## Send a notification

```bash
notify -t "构建完成" "main 分支已部署，耗时 3m12s"
```

- `-t` title, `-p` priority (1 to 5, or `min` `low` `default` `high` `urgent`), `-g` tags (comma separated, emoji shortcodes such as `white_check_mark`).
- One argument is the body. Two arguments are the title and the body. An explicit `-t` skips the title position.
- Success prints nothing and exits 0. A failure prints curl's error and exits non-zero, so check `$?` when it matters.
- Configuration lives in `~/.config/pi-pocket-ntfy/notify.env` (mode 600): `NTFY_URL`, `NTFY_TOPIC` (default `pip-notify`), `NTFY_TOKEN`. Never print the token, never copy the file into a log or a repository.

If `notify` is missing, publish with curl instead:

```bash
set -a; . ~/.config/pi-pocket-ntfy/notify.env; set +a
curl --fail-with-body -sS -H "Authorization: Bearer $NTFY_TOKEN" \
  -H "X-Title: 标题" --data-binary "正文" "$NTFY_URL/$NTFY_TOPIC"
```

## Two topics, different meanings

| Topic | Direction | Use it for |
| --- | --- | --- |
| `pip-notify` | one-way to the owner | Notifications. Nothing reads it back. |
| `pip` | two-way | The `pi-pocket-ntfy` bridge listens here and submits each message to the Pi in Pocket session, then publishes the reply back. |

Publishing to `pip` is giving the PiP assistant a task, not sending a notification. Never send a notification there.

## Rules

- One message carries the result and the next step. Do not send a stream of progress updates.
- No logs, no diffs, no tokens. If the detail matters, write it where the work lives and link or name the path.
- Do not repeat a notification that already went out for the same event.
- The owner may have asked for silence: an explicit instruction always wins over this skill.

## Check what was sent

```bash
set -a; . ~/.config/pi-pocket-ntfy/notify.env; set +a
curl -sS -H "Authorization: Bearer $NTFY_TOKEN" "$NTFY_URL/$NTFY_TOPIC/json?poll=1&since=1h"
```

The server keeps 12 hours of messages. Each line is one JSON event; `event` is `message`, `open`, or `keepalive`.

## Background

`pi-pocket-ntfy` is the bridge behind this: `~/.config/systemd/user/pi-pocket-ntfy.service`, repository `~/git/pi-pocket-ntfy`, source in this machine's `pi-pocket-ntfy` project. The bridge holds the PiP conversation; the notification topic needs no daemon.
