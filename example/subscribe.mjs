import { uniqueName, usingDemoHub } from "./_shared.mjs";

await usingDemoHub(async (hub) => {
  const events = hub.getScope(uniqueName("subscribe")).getVariable("events");
  const received = [];

  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const subscription = await events.sub((value) => {
    received.push(value);
    console.log("received:", value);
    if (received.length === 2) {
      resolveDone();
    }
  });

  try {
    await hub.nats.flush();
    await events.pub({ seq: 1, at: Date.now() });
    await events.pub({ seq: 2, at: Date.now() });

    await done;
    console.log("subscription saw", received.length, "messages");
  } finally {
    subscription.unsubscribe();
  }
});
