import { basename } from "node:path";
import type { Config } from "./config.ts";
import { splitText } from "./format.ts";
import { Ntfy, type NtfyMessage } from "./ntfy.ts";
import { Pocket, finalText, type PocketAttachment, type PocketTarget } from "./pocket.ts";
import { Store } from "./store.ts";
import { setTimeout as sleep } from "node:timers/promises";

const MAX_ATTACHMENT = 20 * 1024 * 1024;

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
    this.store.seeMessage(message.id);
    const text = (message.message || "").trim();
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
