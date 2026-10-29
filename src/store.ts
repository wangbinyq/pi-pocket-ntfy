import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const MAX_SENT = 500;

export interface State {
  topic: string;
  pipId: number;
  cursor: number;
  lastMessageId: string;
  sent: string[];
}

function parse(raw: string, topic: string): State {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("State file is not valid JSON");
  }
  const state = value as Partial<State>;
  if (typeof state !== "object" || state === null) throw new Error("State file is not an object");
  if (state.topic !== topic)
    throw new Error(`State file belongs to topic ${String(state.topic)}, not ${topic}`);
  return {
    topic,
    pipId: Number.isInteger(state.pipId) ? Number(state.pipId) : 0,
    cursor: Number.isInteger(state.cursor) ? Number(state.cursor) : 0,
    lastMessageId: typeof state.lastMessageId === "string" ? state.lastMessageId : "",
    sent: Array.isArray(state.sent) ? state.sent.filter((id) => typeof id === "string") : [],
  };
}

export class Store {
  readonly path: string;
  readonly state: State;
  readonly #sent: Set<string>;

  constructor(path: string, topic: string) {
    this.path = path;
    this.state = existsSync(path)
      ? parse(readFileSync(path, "utf8"), topic)
      : { topic, pipId: 0, cursor: 0, lastMessageId: "", sent: [] };
    this.#sent = new Set(this.state.sent);
  }

  sent(id: string): boolean {
    return this.#sent.has(id);
  }

  markSent(id: string): void {
    this.#sent.add(id);
    this.state.sent = [...this.#sent].slice(-MAX_SENT);
    this.save();
  }

  usePip(id: number, cursor: number): void {
    this.state.pipId = id;
    this.state.cursor = cursor;
    this.save();
  }

  seeMessage(id: string): void {
    this.state.lastMessageId = id;
    this.save();
  }

  advance(cursor: number): void {
    this.state.cursor = cursor;
    this.save();
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(this.path), `.state-${randomUUID()}`);
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify(this.state, null, 2) + "\n");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }
}
