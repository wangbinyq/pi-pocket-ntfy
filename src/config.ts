import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Config {
  pocketUrl: string;
  pocketToken: string;
  ntfyUrl: string;
  ntfyTopic: string;
  ntfyToken?: string;
  stateFile: string;
  pollMs: number;
  chunkLimit: number;
}

function origin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error(`${name} must use HTTPS (HTTP is allowed only on loopback)`);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error(`${name} must be an origin, without path, query, or credentials`);
  return url.origin;
}

function positive(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number`);
  return number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const pocketToken = env.POCKET_TOKEN?.trim();
  if (!pocketToken) throw new Error("Set POCKET_TOKEN to the Pocket owner token");
  const ntfyTopic = (env.NTFY_TOPIC || "pip").trim();
  if (!/^[a-z0-9_-]{1,64}$/i.test(ntfyTopic))
    throw new Error("NTFY_TOPIC must be 1-64 letters, digits, underscores, or dashes");
  const ntfyToken = env.NTFY_TOKEN?.trim();
  return {
    pocketUrl: origin(env.POCKET_URL || "http://127.0.0.1:8080", "POCKET_URL"),
    pocketToken,
    ntfyUrl: origin(env.NTFY_URL || "https://ntfy.sh", "NTFY_URL"),
    ntfyTopic,
    ...(ntfyToken ? { ntfyToken } : {}),
    stateFile: resolve(
      env.NTFY_STATE_FILE || join(homedir(), ".local/share/pi-pocket-ntfy/state.json"),
    ),
    pollMs: positive(env.NTFY_POLL_MS, 1500, "NTFY_POLL_MS"),
    chunkLimit: positive(env.NTFY_CHUNK_LIMIT, 3000, "NTFY_CHUNK_LIMIT"),
  };
}
