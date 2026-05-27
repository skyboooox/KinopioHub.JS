import { enableAutoLeaf } from "../leaf.mjs";
import { DEMO_SERVER, uniqueName, waitFor } from "./_shared.mjs";

const namespace = uniqueName("auto_leaf");
const agent = await enableAutoLeaf({
  discoveryNamespace: namespace,
  nodeId: namespace,
  backboneServers: [DEMO_SERVER],
  webSocketTls: false,
  leaderMissingGraceMs: 1_000,
});

try {
  const status = await waitFor(() => {
    const snapshot = agent.status();
    return snapshot.localLeaf || snapshot.leader ? snapshot : null;
  }, {
    label: "auto leaf leader",
    timeoutMs: 8_000,
    intervalMs: 250,
  }).catch(() => agent.status());

  console.log("agent state:", status.state);
  console.log("agent role:", status.role);
  console.log("leader:", status.leader?.websocketUrl ?? "none yet");
  console.log("local leaf:", status.localLeaf?.websocketUrl ?? "not started here");
} finally {
  await agent.stop();
}
