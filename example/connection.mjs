import { DEMO_SERVER, createDemoHub } from "./_shared.mjs";

console.log("Connecting to", DEMO_SERVER);

const hub = createDemoHub({
  autoConnect: false,
});

const stopStateLog = hub.onStateChange((state) => {
  console.log("state:", state);
});

try {
  await hub.connect();
  await hub.connected(10_000);

  console.log("connected:", hub.isConnected);
  console.log("server:", hub.nats?.getServer?.());

  const bytes = hub.serializeData({ ok: true });
  console.log("serialization round trip:", hub.deserializeData(bytes));

  await hub.reconnect();
  await hub.connected(10_000);
  console.log("reconnected:", hub.state);
} finally {
  stopStateLog();
  await hub.dispose();
}
