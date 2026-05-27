import { uniqueName, usingDemoHub } from "./_shared.mjs";

await usingDemoHub(async (hub) => {
  const calculator = hub.getScope(uniqueName("request_reply")).getVariable("calculator");

  const service = await calculator.serve(async (request) => {
    if (request.operation === "add") {
      return { result: request.a + request.b };
    }
    if (request.operation === "multiply") {
      return { result: request.a * request.b };
    }
    return { error: `unsupported operation: ${request.operation}` };
  });

  try {
    await hub.nats.flush();

    const add = await calculator.req({ operation: "add", a: 2, b: 3 });
    const multiply = await hub.request(calculator.subject, {
      operation: "multiply",
      a: 4,
      b: 5,
    });

    console.log("variable.req response:", add);
    console.log("hub.request response:", multiply);
  } finally {
    service.unsubscribe();
  }
});
