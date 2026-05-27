import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { startLeafNode } from "../leaf.mjs";
import { DEMO_SERVER, uniqueName } from "./_shared.mjs";

const runtimeParent = await mkdtemp(path.join(tmpdir(), "kinopio-leaf-example-"));
const leaf = await startLeafNode({
  discoveryNamespace: uniqueName("manual_leaf"),
  backboneServers: [DEMO_SERVER],
  webSocketTls: false,
  runtimeDir: runtimeParent,
});

try {
  const status = leaf.status();
  console.log("leaf phase:", status.phase);
  console.log("local websocket:", status.websocketUrl);
  console.log("discovery manifest:", status.discoveryUrl);
  console.log("backbone bridge:", status.bridgeState);
} finally {
  await leaf.stop();
  await rm(runtimeParent, { recursive: true, force: true });
}
