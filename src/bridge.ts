import { basename } from "node:path";
import type { Config } from "./config.ts";
import { splitText } from "./format.ts";
import { Ntfy, type NtfyMessage } from "./ntfy.ts";
import { Pocket, finalText, HttpError, type PocketAttachment, type PocketTarget } from "./pocket.ts";
import { Store } from "./store.ts";
import { setTimeout as sleep } from "node:timers/promises";

const MAX_ATTACHMENT = 20 * 1024 * 1024;

const HELP = `PiP ntfy 桥接
/compact [说明] — 立即压缩 PiP 上下文
/reset [交接说明] — 清空上下文，历史保留，会话 ID 不变
/help — 这条帮助

其他文字直接提交给 PiP。命令必须整条消息完全匹配，前后不能有多余内容。`;

interface Command {
  name: "compact" | "reset" | "help";
  argument: string;
}

function parseCommand(text: string): Command | undefined {
  const match = /^\/(compact|reset|help)(?:[ \t]+([\s\S]*))?$/.exec(text);
  if (!match) return undefined;
  return {
    name: match[1] as Command["name"],
    argument: (match[2] || "").trim(),
  };
}

function failed(action: string, error: unknown): string {
  const status = error instanceof HttpError ? error.status : undefined;
  if (status !== undefined && status >= 400 && status < 500)
    return `${action}请求被 Pocket 拒绝（HTTP ${status}），没有执行。请打开 Pocket 检查权限和当前状态。`;
  return `${action}请求已发出，但结果不确定，没有自动重试。请打开 Pocket 检查后，再决定是否重发。`;
}

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

class Mutex {
  #chain: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(task, task);
    this.#chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function safeName(name: string): string {
  return (
    basename(name.replaceAll("\\", "/"))
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/[<>:"/\\|?*]/g, "_")
      .trim()
      .slice(0, 120) || "attachment.bin"
  );
}

function mimeOf(name: string, declared?: string): string {
  const types: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
    ".pdf": "application/pdf",
  };
  const lower = name.toLowerCase();
  for (const [extension, mime] of Object.entries(types))
    if (lower.endsWith(extension)) return mime;
  return declared && declared.includes("/") ? declared.split(";")[0]!.trim() : "application/octet-stream";
}

export class Bridge {
  readonly config: Config;
  readonly pocket: Pocket;
  readonly ntfy: Ntfy;
  readonly store: Store;
  readonly target: PocketTarget;
  readonly signal: AbortSignal;
  readonly #queue: NtfyMessage[] = [];
  readonly #mutex = new Mutex();
  #draining = false;

  constructor(config: Config, pocket: Pocket, ntfy: Ntfy, store: Store, target: PocketTarget, signal: AbortSignal) {
    this.config = config;
    this.pocket = pocket;
    this.ntfy = ntfy;
    this.store = store;
    this.target = target;
    this.signal = signal;
  }

  async start(): Promise<void> {
    await Promise.all([this.#receiving(), this.#replying()]);
  }

  #enqueue(message: NtfyMessage): void {
    this.#queue.push(message);
    void this.#drain();
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length) {
        const message = this.#queue.shift()!;
        try {
          await this.#accept(message);
        } catch (error) {
          log(`input failed: ${(error as Error).message}`);
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  async #accept(message: NtfyMessage): Promise<void> {
    await this.#mutex.run(() => this.#submit(message));
  }

  async #submit(message: NtfyMessage): Promise<void> {
    if (message.event !== "message") return;
    if (!message.id || this.store.sent(message.id)) return;
    if (message.id === this.store.state.lastMessageId) return;
    const previous = this.store.state.lastMessageId;
    this.store.seeMessage(message.id);
    const text = (message.message || "").trim();
    const command = parseCommand(text);
    if (command) {
      await this.#command(command);
      return;
    }
    try {
      const attachments: PocketAttachment[] = [];
      if (message.attachment) {
        const size = message.attachment.size ?? 0;
        if (size > MAX_ATTACHMENT) throw new Error("attachment is larger than 20 MiB");
        const name = safeName(message.attachment.name || "attachment.bin");
        const bytes = await this.ntfy.download(message.attachment.url);
        if (bytes.length > MAX_ATTACHMENT) throw new Error("attachment is larger than 20 MiB");
        attachments.push(
          await this.pocket.upload(this.target.id, bytes, name, mimeOf(name, message.attachment.type)),
        );
      }
      if (!text && attachments.length === 0) return;
      await this.pocket.submit(
        this.target.id,
        text || "请看附件。",
        `ntfy-${message.id}`,
        "followUp",
        attachments,
      );
      log(`submitted ntfy message ${message.id} (text=${text.length} chars, attachments=${attachments.length})`);
    } catch (error) {
      this.store.seeMessage(previous);
      throw error;
    }
  }

  async #reply(text: string): Promise<void> {
    const id = await this.ntfy.publish(text);
    this.store.markSent(id);
  }

  async #command(command: Command): Promise<void> {
    if (command.name === "help") {
      await this.#reply(HELP);
      return;
    }
    if (command.name === "compact") {
      if (Array.from(command.argument).length > 8000) {
        await this.#reply("说明太长（上限 8000 字），没有执行。");
        return;
      }
      try {
        await this.pocket.compact(this.target.id, command.argument || undefined);
      } catch (error) {
        log(`/compact failed: ${(error as Error).message}`);
        await this.#reply(failed("压缩", error));
        return;
      }
      await this.#reply("PiP 上下文压缩已开始，摘要任务在后台进行。");
      return;
    }
    if (Array.from(command.argument).length > 20_000) {
      await this.#reply("交接说明太长（上限 20000 字），没有执行。");
      return;
    }
    try {
      await this.pocket.reset(this.target.id, command.argument || undefined);
    } catch (error) {
      log(`/reset failed: ${(error as Error).message}`);
      await this.#reply(failed("重置", error));
      return;
    }
    await this.#reply("PiP 上下文已重置。");
  }

  async #receiving(): Promise<void> {
    while (!this.signal.aborted) {
      const since = this.store.state.lastMessageId || "15m";
      try {
        await this.ntfy.stream(since, (message) => this.#enqueue(message), this.signal);
        log("ntfy stream ended; reconnecting");
      } catch (error) {
        if (this.signal.aborted) return;
        log(`ntfy stream failed: ${(error as Error).message}`);
      }
      try {
        const missed = await this.ntfy.poll(this.store.state.lastMessageId || "15m");
        for (const message of missed) this.#enqueue(message);
      } catch (error) {
        if (this.signal.aborted) return;
        log(`ntfy catch-up failed: ${(error as Error).message}`);
      }
      await sleep(5000, undefined, { signal: this.signal }).catch(() => undefined);
    }
  }

  async #replying(): Promise<void> {
    while (!this.signal.aborted) {
      try {
        const entries = await this.pocket.after(this.target.id, this.store.state.cursor);
        for (const entry of entries) {
          const text = finalText(entry);
          if (text)
            await this.#mutex.run(async () => {
              for (const chunk of splitText(text, this.config.chunkLimit)) {
                const id = await this.ntfy.publish(chunk);
                this.store.markSent(id);
              }
            });
          this.store.advance(entry.id);
        }
      } catch (error) {
        if (this.signal.aborted) return;
        log(`reply sync failed: ${(error as Error).message}`);
      }
      await sleep(this.config.pollMs, undefined, { signal: this.signal }).catch(() => undefined);
    }
  }
}
