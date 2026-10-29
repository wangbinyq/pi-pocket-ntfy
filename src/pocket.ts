export interface PocketEntry {
  id: number;
  kind: string;
  blocks?: { type: string; text?: string }[];
  stopReason?: string;
  error?: string;
}

export interface PocketAttachment {
  path: string;
  name: string;
  mime: string;
  size: number;
}

export interface PocketTarget {
  id: number;
  title: string;
}

export interface PocketRunning {
  id: number;
  title: string;
  busy: boolean;
  approvals: number;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(url: string, status: number) {
    super(`${new URL(url).hostname}: HTTP ${status}`);
    this.status = status;
  }
}

export class Pocket {
  readonly base: string;
  readonly token: string;
  readonly signal?: AbortSignal;

  constructor(base: string, token: string, signal?: AbortSignal) {
    this.base = base;
    this.token = token;
    this.signal = signal;
  }

  async #json(path: string, body?: object, timeout = 30_000): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "X-Pocket": "1",
      "Content-Type": "application/json",
    };
    const deadline = AbortSignal.timeout(timeout);
    const response = await fetch(`${this.base}/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: this.signal ? AbortSignal.any([this.signal, deadline]) : deadline,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(`${this.base}/api/${path}`, response.status);
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON from Pocket for /api/${path}`);
    }
  }

  async principal(): Promise<string> {
    const me = (await this.#json("me")) as { user?: { id?: string; role?: string } };
    if (!me.user?.id || me.user.role !== "owner")
      throw new Error("POCKET_TOKEN must belong to the Pocket owner");
    return me.user.id;
  }

  async pip(): Promise<PocketTarget> {
    const result = (await this.#json("pip", { on: true })) as { pip?: { id?: number } };
    const id = result.pip?.id;
    if (!Number.isInteger(id) || !id) throw new Error("Enable PiP in Pocket's Extensions first");
    return { id, title: "Pi in Pocket" };
  }

  async #page(id: number, before?: number): Promise<PocketEntry[]> {
    const body = (await this.#json(`c/${id}/history${before ? `?before=${before}` : ""}`)) as unknown;
    if (!Array.isArray(body)) throw new Error("Pocket history is not an array");
    return body as PocketEntry[];
  }

  async head(id: number): Promise<number> {
    return Math.max(0, ...(await this.#page(id)).map((entry) => entry.id));
  }

  async after(id: number, cursor: number): Promise<PocketEntry[]> {
    const found = new Map<number, PocketEntry>();
    let before: number | undefined;
    for (let page = 0; page < 1000; page++) {
      const entries = await this.#page(id, before);
      for (const entry of entries) if (entry.id > cursor) found.set(entry.id, entry);
      const first = Math.min(...entries.map((entry) => entry.id));
      if (entries.length === 0 || first <= cursor)
        return [...found.values()].sort((a, b) => a.id - b.id);
      if (before !== undefined && first >= before)
        throw new Error("Pocket history pagination did not advance");
      before = first;
    }
    throw new Error("History catch-up exceeds 1000 pages; cursor was not advanced");
  }

  async running(): Promise<PocketRunning[]> {
    const body = (await this.#json("running")) as unknown;
    if (!Array.isArray(body)) throw new Error("Pocket running list is not an array");
    return body as PocketRunning[];
  }

  async compact(id: number, instructions?: string): Promise<void> {
    await this.#json(`c/${id}/compact`, instructions ? { instructions } : {});
  }

  async reset(id: number, note?: string): Promise<void> {
    await this.#json(`c/${id}/reset`, note ? { note } : {});
  }

  async submit(
    id: number,
    text: string,
    requestId: string,
    mode: "steer" | "followUp",
    attachments: PocketAttachment[] = [],
  ): Promise<void> {
    await this.#json(`c/${id}/submit`, {
      text,
      requestId,
      mode,
      ...(attachments.length ? { attachments } : {}),
    });
  }

  async upload(id: number, bytes: Uint8Array<ArrayBuffer>, name: string, mime: string): Promise<PocketAttachment> {
    const deadline = AbortSignal.timeout(60_000);
    const response = await fetch(
      `${this.base}/api/c/${id}/upload?name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "X-Pocket": "1",
          "Content-Type": mime,
          "Content-Length": String(bytes.length),
        },
        body: bytes,
        redirect: "error",
        signal: this.signal ? AbortSignal.any([this.signal, deadline]) : deadline,
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(`${this.base}/api/c/${id}/upload`, response.status);
    }
    return (await response.json()) as PocketAttachment;
  }
}

export function finalText(entry: PocketEntry): string | undefined {
  if (
    entry.kind !== "assistant" ||
    entry.stopReason === "toolUse" ||
    entry.blocks?.some((block) => block.type === "toolCall")
  )
    return undefined;
  const text = (entry.blocks || [])
    .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
    .join("\n")
    .trim();
  if (entry.error || entry.stopReason === "error") return "任务失败，请在 Pocket 查看详情。";
  if (entry.stopReason === "aborted") return "任务已停止。";
  if (entry.stopReason === "length")
    return (text ? text + "\n\n" : "") + "回复达到长度限制，请在 Pocket 查看。";
  return text || undefined;
}
