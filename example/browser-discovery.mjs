import KinopioHub from "../kinopio.mjs";

console.log("=== KinopioHub Browser Discovery Example ===");

const hub = new KinopioHub({
  autoConnect: false,
  serverSelectionMode: "ordered",
  servers: ["wss://remote.example.com:443"],
  discovery: {
    enabled: true,
    manifestUrl: "https://app.example.com/.well-known/kinopio-leader.json",
    backgroundLocalProbe: true,
    localSwitchTimeoutMs: 1_500,
    cacheTtlMs: 5_000,
  },
});

console.log("Constructed a browser-friendly hub that will connect remote first and then probe the local leaf in the background when used in a browser session.");

await hub.dispose();
