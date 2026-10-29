export interface NtfyAttachment {
  name: string;
  url: string;
  size?: number;
  type?: string;
}

export interface NtfyMessage {
  id: string;
  time: number;
  event: string;
  topic?: string;
  message?: string;
  title?: string;
  attachment?: NtfyAttachment;
}

export class Ntfy {
  readonly base: string;
  readonly topic: string;
  readonly token?: string;

  constructor(base: string, topic: string, token?: string) {
    this.base = base;
    this.topic = topic;
    this.token = token;
  }

  #auth(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  #topicUrl(suffix: string, query: Record<string, string> = {}): string {
    const url = new URL(`${this.base}/${this.topic}${suffix}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url.toString();
  }

  async publish(text: string): Promise<string> {
    const response = await fetch(this.#topicUrl(""), {
      method: "POST",
      headers: { ...this.#auth(), "Content-Type": "text/plain; charset=utf-8" },
      body: text,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`ntfy publish failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { id?: string };
    if (!body.id) throw new Error("ntfy publish returned no message id");
    return body.id;
  }

  async download(url: string): Promise<Uint8Array<ArrayBuffer>> {
    const response = await fetch(url, {
      headers: this.#auth(),
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`ntfy attachment download failed: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async poll(since: string): Promise<NtfyMessage[]> {
    const response = await fetch(this.#topicUrl("/json", { poll: "1", since }), {
      headers: this.#auth(),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`ntfy poll failed: HTTP ${response.status}`);
    }
    const messages: NtfyMessage[] = [];
    for (const line of (await response.text()).split("\n")) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line) as NtfyMessage);
      } catch {
        throw new Error("ntfy poll returned invalid JSON");
      }
    }
    return messages;
  }

  async stream(
    since: string,
    onMessage: (message: NtfyMessage) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await fetch(this.#topicUrl("/json", { since }), {
      headers: this.#auth(),
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`ntfy stream failed: HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("ntfy stream returned no body");
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) onMessage(JSON.parse(line) as NtfyMessage);
          newline = buffer.indexOf("\n");
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}
