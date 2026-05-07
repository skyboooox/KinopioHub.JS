import { enableAutoLeaf } from "../leaf.mjs";

console.log("=== KinopioHub Auto Leaf Example ===");

const autoLeaf = await enableAutoLeaf({
  discoveryNamespace: "example",
});

console.log(autoLeaf.status());

setTimeout(async () => {
  console.log("Stopping auto leaf agent...");
  await autoLeaf.stop();
  console.log("Stopped.");
  process.exit(0);
}, 8_000);
