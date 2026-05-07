# KinopioHub.JS

Cloud-native communication framework designed to use remote variables and functions locally

[![npm version](https://badge.fury.io/js/kinopio-hub.svg?icon=si%3Anpm)](https://www.npmjs.com/package/kinopio-hub)
![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-green)

[中文](./README_CN.md)

## Features

- 🔍 Automatic value tracking and caching
- 🌳 Hierarchical scope system
- 🔄 Automatic reconnection handling
- 🛡️ Built-in error handling and retry mechanisms
- 🧭 Node-only local leaf runtime, LAN auto-election, browser background discovery, and packaged CLI support

## Installation

```bash
npm install kinopio-hub
```

On `npm install`, the package now performs a best-effort prefetch of the official `nats-server v2.12.7` binary into the user cache so the Node-only leaf runtime can start quickly later. Set `KINOPIO_SKIP_NATS_SERVER_DOWNLOAD=1` if you need to skip that prefetch during installation.

## Quick Start

```javascript
import KinopioHub, { KINOPIO_STATE_EVENT } from 'kinopio-hub';

// Create new instance
const hub = new KinopioHub({
  servers: ["wss://nats.example.com:443"],
  debug: true
});

// Use scoped variables
const myScope = hub.getScope("myScope");
const myVar = myScope.getVariable("myVar");

// Publish data
await myVar.pub({ message: "Hello!" });

// Subscribe to updates
await myVar.sub(data => {
  console.log("Received:", data);
});
```

## Core Concepts

### KinopioHub

The main client class for managing connections and providing access to scopes and variables.

```javascript
const hub = new KinopioHub({
  servers: ["wss://demo.nats.io:8443", "wss://demo.nats.io:4443"],
  serverSelectionMode: "latency",
  debug: true,
  noEcho: false,
  reconnectTimeout: 5000
});
```

### Scopes

Scopes help organize variables into logical groups:

```javascript
// Get scope
const userScope = hub.getScope("users");

// Access variables within scope
const onlineUsers = userScope.getVariable("online");
const userCount = userScope.getVariable("count");

// Dynamic property access
const onlineUsers = hub.users.online;  // Equivalent to above
```

### Variables

Variables are data containers within scopes that support publish, subscribe, and request-response patterns:

```javascript
// Publish
await myVar.pub({ count: 42 });

// Subscribe
await myVar.sub(data => {
  console.log("Value updated:", data);
});

// Request-response pattern
const response = await myVar.req({ action: "getData" });

// Service handler
await myVar.serve(async (request) => {
  if (request.action === "getData") {
    return { value: "some data" };
  }
});
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| servers | string[] | ["wss://demo.nats.io:8443", "wss://demo.nats.io:4443"] | List of NATS server URLs |
| debug | boolean | false | Enable debug logging |
| noEcho | boolean | false | Don't receive own published messages |
| serverSelectionMode | "ordered" \| "random" \| "latency" | "latency" | How KinopioHub orders multiple candidate servers before connecting |
| maxReconnectAttempts | number | -1 | Maximum reconnection attempts (-1 for infinite) |
| waitOnFirstConnect | boolean | true | Wait for first connection |
| reconnectTimeout | number | 5000 | Reconnection timeout (milliseconds) |
| reconnectTimeWait | number | 500 | Reconnection interval (milliseconds) |
| pingInterval | number | 3000 | Ping interval (milliseconds) |
| maxPingOut | number | 3 | Maximum unresponded pings before reconnect |
| timeout | number | 3000 | Operation timeout (milliseconds) |
| healthReport | number | 5000 | Health report interval (milliseconds) |
| autoConnect | boolean | true | Start connecting as soon as the hub is constructed |
| autoRetry | boolean | true | Auto retry on connection failure |
| retryDelay | number | 1000 | Initial retry delay (ms) |
| retryBackoffFactor | number | 1.5 | Backoff multiplier |
| maxRetryDelay | number | 30000 | Max retry delay (ms) |
| discovery | `{ enabled?, manifestUrl?, backgroundLocalProbe?, localSwitchTimeoutMs?, cacheTtlMs? }` | undefined | Browser-side local leaf discovery controls for the background LAN probe and hot-switch flow |
| codec | {encode(data):Uint8Array, decode(bytes):any} | undefined | Custom codec for serialization |
| jsonReplacer | Function | undefined | JSON.stringify replacer |
| jsonReviver | Function | undefined | JSON.parse reviver |

Legacy `noRandomize` is still accepted as a compatibility alias when `serverSelectionMode` is not set, but it is no longer the primary public option.

Browser discovery now runs in the root browser-friendly runtime when `discovery.enabled === true`. The default flow is still "connect to the configured remote servers first, then probe for a local leaf in the background". Probe failures stay silent and do not block the initial remote session.

### Server Selection Modes

- `ordered`: keep the input server order for the initial connect and the underlying NATS reconnect sequence.
- `random`: reshuffle the candidate server order before each fresh connect or manual reconnect, then keep that shuffled order stable for that connection lifecycle.
- `latency`: the default mode. Before each fresh connect or manual reconnect, KinopioHub probes every configured server in parallel, measures RTT using the NATS client's `flush()` / `rtt()` semantics, then prefers healthy servers with lower RTT. Probe failures are kept at the end in original input order, and if every probe fails the library falls back to the original input order. After a successful latency-mode connection, KinopioHub re-probes every 10 minutes and hot-switches only when another healthy server is at least 30ms faster. The switch flow rebuilds value tracking, logical subscriptions, and services on the new connection before draining the old one. During that brief dual-subscription window, regular subscribers may observe a very small number of duplicate callbacks.

### Typical Mode Examples

```javascript
// Keep a fixed primary/fallback order
const orderedHub = new KinopioHub({
  servers: ["wss://primary.example.com:443", "wss://backup.example.com:443"],
  serverSelectionMode: "ordered"
});

// Reshuffle candidates on each fresh connect cycle
const randomHub = new KinopioHub({
  servers: ["wss://a.example.com:443", "wss://b.example.com:443"],
  serverSelectionMode: "random"
});

// Prefer the lowest-latency server and auto-migrate in the background
const latencyHub = new KinopioHub({
  servers: ["wss://edge-a.example.com:443", "wss://edge-b.example.com:443"],
  serverSelectionMode: "latency"
});
```

### Browser Local Discovery

```javascript
const hub = new KinopioHub({
  servers: ["wss://remote.example.com:443"],
  serverSelectionMode: "ordered",
  discovery: {
    enabled: true,
    manifestUrl: "https://app.example.com/.well-known/kinopio-leader.json",
    backgroundLocalProbe: true,
    localSwitchTimeoutMs: 1500,
    cacheTtlMs: 5000,
  },
});
```

- `manifestUrl` defaults to the current page origin plus `/.well-known/kinopio-leader.json` when you omit it.
- The browser stays on the configured remote servers for the initial connect, then fetches the discovery manifest in the background.
- If the manifest exposes a healthy local `wssUrl` and the browser can really establish that local connection, KinopioHub hot-switches the current session to the local leaf and rebuilds value tracking, subscriptions, and services on the new connection before draining the old one.
- If the local leaf disappears later, KinopioHub falls back to the configured remote servers and keeps probing in the background for the next usable local leader.
- If the manifest fetch fails or the browser cannot trust/connect to the discovered local `wss`, the current remote session stays in place.
- Browsers on other devices are still constrained by ordinary TLS trust rules. Installing trust on the leader machine helps that machine's browser first; it does not magically make every remote browser trust the same local CA.

### Operational Boundaries

- A browser session is not itself a leaf node and does not launch `nats-server` directly.
- A Node-capable device participates in discovery and election through `enableAutoLeaf()` or `kinopio-hub leaf auto`.
- If a healthy leader already exists in the same `discoveryNamespace`, a new capable device stays in `following-leader` and does not start a duplicate local leaf.
- In open multi-device browser environments, local-first routing remains an enhancement path because TLS trust still has to exist on each browser device.

## Advanced Usage

### Packaged CLI

After installation, the package exposes a `kinopio-hub` CLI:

```bash
kinopio-hub --help
kinopio-hub leaf start --discovery-namespace studio
kinopio-hub leaf auto --discovery-namespace studio --backbone-server nats://upstream.example.com:7422
```

- `kinopio-hub leaf start` is the manual runtime wrapper around `startLeafNode()`.
- `kinopio-hub leaf auto` is the auto-election wrapper around `enableAutoLeaf()`.
- Both commands keep running until `Ctrl+C`, print an initial status snapshot, and accept `--json` if you want machine-readable output only.
- The CLI uses the same generated-CA / trust-install behavior as the Node-only leaf API, including `KINOPIO_SKIP_CA_TRUST_INSTALL=1` for CI or restricted environments.

### Node-only Leaf Entrypoint

The package now exposes a Node-only subpath for the local leaf runtime:

```javascript
import { enableAutoLeaf, startLeafNode } from "kinopio-hub/leaf";
```

`enableAutoLeaf()` is now the phase-3 high-level entrypoint. It joins a LAN-scoped coordination namespace, reuses a stable cached `nodeId`, listens for an existing healthy leaf over UDP multicast plus mDNS, and only starts a local leaf when the namespace needs a leader.

```javascript
import { enableAutoLeaf } from "kinopio-hub/leaf";

const autoLeaf = await enableAutoLeaf({
  discoveryNamespace: "studio",
  backboneServers: ["nats://upstream.example.com:7422"],
  leaderMissingGraceMs: 10_000,
});

console.log(autoLeaf.status());

// Later:
await autoLeaf.stop();
```

`startLeafNode()` remains the low-level manual runtime entrypoint. It resolves a cached `nats-server` binary, writes a temporary config, starts a local leaf server, exposes WSS plus an HTTPS discovery manifest, and returns a handle with `wssUrl`, `discoveryUrl`, `clientUrl`, `monitorUrl`, `status()`, and `stop()`.

```javascript
import { startLeafNode } from "kinopio-hub/leaf";

const leaf = await startLeafNode({
  discoveryNamespace: "studio",
  backboneServers: ["nats://upstream.example.com:7422"],
});

console.log(leaf.status());
await leaf.stop();
```

Leaf runtime notes:

- `backboneServers` are normalized into NATS leaf remote URLs and are optional. If they are unreachable, `startLeafNode()` can still succeed locally while `status().bridgeState` stays `"connecting"`.
- `enableAutoLeaf()` keeps one leader per `discoveryNamespace`. If a healthy leader is already present, new capable devices stay in `following-leader` and do not start a duplicate local leaf.
- If the leader disappears, followers wait through `leaderMissingGraceMs` before electing a replacement. The default grace window is 10 seconds.
- When RTT measurements are available, election priority is lower RTT first, measurable RTT over unmeasurable RTT, then stable `nodeId`. Healthy leaders are only preempted after a sustained advantage of at least 50ms.
- The local client listener binds to loopback, while WSS and discovery bind to the detected LAN address by default.
- If you do not provide `tls.certFile` and `tls.keyFile`, the leaf runtime now auto-generates a reusable local root CA, issues a short-lived leaf certificate for the current `advertisedHostname`, and then best-effort attempts to install that CA into the current leader device's trust store.
- `status().tls` reports whether the runtime is using caller-provided PEM files or the generated local CA, and whether CA trust installation was `installed`, `skipped`, `failed`, or left `external`.
- Automatic trust installation is intentionally best-effort. On open multi-device browser deployments, a remote browser may still reject the local `wss` until that device also trusts the CA.
- Set `KINOPIO_SKIP_CA_TRUST_INSTALL=1` if you need to skip trust-store mutation during CI, automation, or other restricted environments.
- The root `kinopio-hub` entrypoint remains browser-friendly and does not pull in Node-only process control logic.
- Example files in this repository:
  [example/leaf-entrypoint.mjs](./example/leaf-entrypoint.mjs),
  [example/auto-leaf.mjs](./example/auto-leaf.mjs),
  [example/browser-discovery.mjs](./example/browser-discovery.mjs)

### Connection Management

```javascript
// Wait for connection
await hub.connected();

// Manual reconnection
await hub.reconnect();

// Clean up resources
await hub.dispose();
```

### Error Handling

```javascript
try {
  await myVar.pub(data);
} catch (error) {
  console.error("Publish failed:", error);
}

// Enable debug logging
const hub = new KinopioHub({ debug: true });

// Listen to state changes
const stop = hub.onStateChange((state) => console.log('state:', state));
// or using event constant
// event.on(KINOPIO_STATE_EVENT, listener)
stop();
```

For tests, SSR setup, or manual connection control, disable automatic connection:

```javascript
const hub = new KinopioHub({ autoConnect: false });
await hub.connect();
```

### Service Mode

```javascript
// Server side
await myVar.serve(async (request) => {
  if (request.action === "increment") {
    return { value: currentValue + 1 };
  }
  throw new Error("Unknown action");
});

// Client side
const response = await myVar.req({ action: "increment" });
console.log(response.value);
```

## Examples

See the [examples directory](./example) for more detailed examples.

> Note on default servers: the default `servers` values use NATS demo endpoints and are intended for development/testing only. For production, configure your own secure NATS servers.

## Development

See [How_To_Dev.md](./How_To_Dev.md) for development guidelines.

Quick verification commands:

```bash
npm test
npm run test:bun
```

## License

GPL-3.0-or-later - see [LICENSE](./LICENSE) file for details.
