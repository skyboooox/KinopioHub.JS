import { uniqueName, usingDemoHub } from "./_shared.mjs";

await usingDemoHub(async (hub) => {
  const messages = hub.getScope(uniqueName("publish")).getVariable("messages");

  await messages.pub({
    text: "hello from KinopioHub.JS",
    at: Date.now(),
  });
  await hub.nats.flush();

  console.log("published one message to:", messages.subject);
  console.log("latest local value:", messages.value);
});
