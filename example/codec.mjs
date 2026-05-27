import { uniqueName, usingDemoHub } from "./_shared.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const codec = {
  encode(value) {
    return encoder.encode(JSON.stringify({ wrapped: value }));
  },
  decode(bytes) {
    return JSON.parse(decoder.decode(bytes)).wrapped;
  },
};

await usingDemoHub(async (hub) => {
  const state = hub.getScope(uniqueName("codec")).getVariable("state");

  let resolveReceived;
  const received = new Promise((resolve) => {
    resolveReceived = resolve;
  });
  const subscription = await state.sub(resolveReceived);

  try {
    await hub.nats.flush();
    await state.pub({ codec: "custom-json-wrapper", ok: true });

    console.log("decoded subscription value:", await received);
    console.log("manual codec round trip:", hub.deserializeData(hub.serializeData({ direct: true })));
  } finally {
    subscription.unsubscribe();
  }
}, { codec });
