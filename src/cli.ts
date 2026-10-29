import { loadConfig } from "./config.ts";
import { Ntfy } from "./ntfy.ts";
import { Pocket } from "./pocket.ts";
import { Store } from "./store.ts";
import { Bridge } from "./bridge.ts";

const command = process.argv[2] || "start";

async function doctor(): Promise<void> {
  const config = loadConfig();
  const pocket = new Pocket(config.pocketUrl, config.pocketToken);
  const owner = await pocket.principal();
  const pip = await pocket.pip();
  const ntfy = new Ntfy(config.ntfyUrl, config.ntfyTopic, config.ntfyToken);
  const id = await ntfy.publish(`ntfy 桥接自检 ${new Date().toISOString()}`);
  const store = new Store(config.stateFile, config.ntfyTopic);
  store.markSent(id);
  console.log(`pocket     ${config.pocketUrl} (owner ${owner.slice(0, 6)}…)`);
  console.log(`pip        conversation ${pip.id}`);
  console.log(`ntfy       ${config.ntfyUrl}/${config.ntfyTopic} (auth ${config.ntfyToken ? "token" : "none"})`);
  console.log(`published  test message ${id}`);
  console.log(`state      ${config.stateFile} cursor=${store.state.cursor} last=${store.state.lastMessageId || "-"}`);
}

async function start(): Promise<void> {
  const config = loadConfig();
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      console.log(`${new Date().toISOString()} ${signal} received; stopping`);
      controller.abort();
    });
  const pocket = new Pocket(config.pocketUrl, config.pocketToken, controller.signal);
  const ntfy = new Ntfy(config.ntfyUrl, config.ntfyTopic, config.ntfyToken);
  const store = new Store(config.stateFile, config.ntfyTopic);
  await pocket.principal();
  const pip = await pocket.pip();
  if (store.state.pipId !== pip.id) store.usePip(pip.id, await pocket.head(pip.id));
  const bridge = new Bridge(config, pocket, ntfy, store, pip, controller.signal);
  console.log(`${new Date().toISOString()} ntfy bridge started: topic=${config.ntfyTopic} pip=${pip.id} cursor=${store.state.cursor}`);
  await bridge.start();
  console.log(`${new Date().toISOString()} ntfy bridge stopped`);
}

try {
  if (command === "doctor") await doctor();
  else if (command === "start") await start();
  else throw new Error(`Unknown command ${command}; use start or doctor`);
} catch (error) {
  console.error(`${new Date().toISOString()} ${(error as Error).message}`);
  process.exitCode = 1;
}
