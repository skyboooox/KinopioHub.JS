import KinopioHub from "../kinopio.mjs";

export const DEMO_SERVER = "wss://demo.nats.io:8443";

export function uniqueName(label) {
  const suffix = `${Date.now()}.${Math.random().toString(16).slice(2)}`;
  return `kinopio.examples.${label}.${suffix}`;
}

export function createDemoHub(options = {}) {
  return new KinopioHub({
    servers: [DEMO_SERVER],
    serverSelectionMode: "ordered",
    autoLeaf: false,
    discovery: false,
    autoRetry: false,
    timeout: 5_000,
    ...options,
  });
}

export function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function waitFor(predicate, {
  label = "condition",
  timeoutMs = 5_000,
  intervalMs = 25,
} = {}) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await delay(intervalMs);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

export async function usingDemoHub(callback, options = {}) {
  const hub = createDemoHub(options);

  try {
    await hub.connected(10_000);
    return await callback(hub);
  } finally {
    await hub.dispose();
  }
}
