import { startLeafNode } from "../leaf.mjs";

console.log("=== KinopioHub Manual Leaf Runtime Example ===");

const leaf = await startLeafNode({
  discoveryNamespace: "example",
});

console.log(leaf.status());

setTimeout(async () => {
  console.log("Stopping local leaf...");
  await leaf.stop();
  console.log("Stopped.");
  process.exit(0);
}, 5_000);
