import { DEMO_SERVER, createDemoHub, delay } from "./_shared.mjs";

const hub = createDemoHub({
  discovery: {
    enabled: true,
    manifestUrl: "http://127.0.0.1:1/.well-known/kinopio-leader.json",
    backgroundLocalProbe: true,
    localSwitchTimeoutMs: 300,
    cacheTtlMs: 500,
  },
});

try {
  await hub.connected(10_000);
  console.log("remote connection is ready:", hub.nats?.getServer?.());
  console.log("configured demo server:", DEMO_SERVER);
  console.log("a failed local discovery probe does not replace the remote connection");
  await delay(400);
} finally {
  await hub.dispose();
}
