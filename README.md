# KinopioHub.JS

KinopioHub.JS is a browser-friendly and Node-capable JavaScript client for using NATS subjects as local variables and request handlers.

[![npm version](https://badge.fury.io/js/kinopio-hub.svg?icon=si%3Anpm)](https://www.npmjs.com/package/kinopio-hub)
![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-green)

[中文](./README_CN.md)

## Install

```bash
npm install kinopio-hub
```

During install the package best-effort downloads `nats-server v2.12.7` into the user cache for the Node-only leaf runtime. Set `KINOPIO_SKIP_NATS_SERVER_DOWNLOAD=1` to skip that install-time prefetch.

## Quick Start

```javascript
import KinopioHub from "kinopio-hub";

const hub = new KinopioHub({
  servers: ["wss://demo.nats.io:8443"],
  serverSelectionMode: "ordered",
  autoLeaf: false,
  discovery: false,
});

await hub.connected();

const status = hub.getScope("demo").getVariable("status");

const subscription = await status.sub((value) => {
  console.log("status changed:", value);
});

await status.pub({ online: true, at: Date.now() });

subscription.unsubscribe();
await hub.dispose();
```

Important demo note: `KinopioHub` can do local discovery and, in non-browser Node runtimes, auto-start a local leaf. The examples in this repository deliberately set `autoLeaf: false` and `discovery: false` when demonstrating the public demo server so all traffic goes to `wss://demo.nats.io:8443`.

## Feature Map

| Feature | API | Example |
| --- | --- | --- |
| Connection lifecycle | `connect()`, `connected()`, `reconnect()`, `dispose()`, `onStateChange()` | [example/connection.mjs](./example/connection.mjs) |
| Scopes and variables | `getScope()`, `getVariable()`, dynamic `hub.scope.variable` access | [example/scope.mjs](./example/scope.mjs) |
| Publish | `variable.pub()` | [example/publish.mjs](./example/publish.mjs) |
| Subscribe | `variable.sub()`, returned subscription handles | [example/subscribe.mjs](./example/subscribe.mjs) |
| Request/reply | `variable.serve()`, `variable.req()`, `hub.request()` | [example/request-reply.mjs](./example/request-reply.mjs) |
| Serialization | `codec`, `serializeData()`, `deserializeData()` | [example/codec.mjs](./example/codec.mjs) |
| Browser local discovery | `discovery` option and manifest probing | [example/browser-discovery.mjs](./example/browser-discovery.mjs) |
| Manual local leaf | `startLeafNode()` from `kinopio-hub/leaf` | [example/leaf-entrypoint.mjs](./example/leaf-entrypoint.mjs) |
| LAN auto leaf | `enableAutoLeaf()` from `kinopio-hub/leaf` | [example/auto-leaf.mjs](./example/auto-leaf.mjs) |

## Core API

### KinopioHub

```javascript
const hub = new KinopioHub({
  servers: ["wss://demo.nats.io:8443"],
  serverSelectionMode: "ordered",
  autoConnect: false,
  autoRetry: false,
});

const stop = hub.onStateChange((state) => console.log(state));

await hub.connect();
await hub.connected(10_000);
await hub.reconnect();

stop();
await hub.dispose();
```

`servers` must be `ws://` or `wss://` URLs for the root client. Use `autoRetry: false` in tests or examples that should fail fast when the server is unavailable.

### Scopes

Scopes are the first subject segment you manage explicitly. Variables append one more segment.

```javascript
const devices = hub.getScope("devices");
const battery = devices.getVariable("battery");

console.log(battery.subject); // devices.battery

const sameVariable = hub.devices.battery;
```

Dynamic property access is convenient, but `getScope()` and `getVariable()` are clearer when names are computed at runtime.

### Variables

```javascript
const temperature = hub.getScope("room").getVariable("temperature");

await temperature.pub({ celsius: 22.5 });

const sub = await temperature.sub((value, message) => {
  console.log(value, message.subject);
});

console.log(temperature.value);

sub.unsubscribe();
```

Each variable tracks its latest local value. Publishing identical bytes twice in a row from the same variable is deduplicated.

### Request/Reply

```javascript
const calculator = hub.getScope("math").getVariable("calculator");

const service = await calculator.serve(async (request) => {
  return { result: request.a + request.b };
});

const response = await calculator.req({ a: 2, b: 3 });
console.log(response.result);

service.unsubscribe();
```

`hub.request(subject, data)` is also available when you already have a subject string.

## Options

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `servers` | `string[]` | `["wss://demo.nats.io:8443", "wss://demo.nats.io:4443"]` | Root client WebSocket endpoints. |
| `debug` | `boolean` | `false` | Prints connection, retry, discovery, and hot-switch logs. |
| `noEcho` | `boolean` | `false` | Set `true` to avoid receiving messages published by the same connection. |
| `serverSelectionMode` | `"ordered" \| "random" \| "latency"` | `"latency"` | Controls candidate ordering before a fresh connection. |
| `autoConnect` | `boolean` | `true` | Set `false` for manual `connect()`. |
| `autoRetry` | `boolean` | `true` | Set `false` for fail-fast tests. |
| `timeout` | `number` | `3000` | Operation timeout in milliseconds. |
| `retryDelay` | `number` | `1000` | First reconnect delay before jitter/backoff. |
| `retryBackoffFactor` | `number` | `1.5` | Retry delay multiplier. |
| `maxRetryDelay` | `number` | `30000` | Upper bound for retry delay. |
| `discovery` | `false \| object` | `{ enabled: true }` | Manifest-based local leaf probing and hot-switching. |
| `autoLeaf` | `boolean \| object` | Node: enabled, browser: disabled | Non-browser Node auto leaf startup. |
| `codec` | `{ encode, decode }` | `undefined` | Custom binary serialization. |
| `jsonReplacer` / `jsonReviver` | functions | `undefined` | JSON fallback customization. |

Legacy `noRandomize` is still accepted when `serverSelectionMode` is not set. Prefer `serverSelectionMode` in new code.

## Server Selection

- `ordered`: keep the input server order.
- `random`: shuffle candidates for each fresh connection lifecycle.
- `latency`: probe candidates, prefer lower RTT, then periodically re-probe. If a later candidate is at least 30ms faster, KinopioHub can rebuild value tracking, subscriptions, and services on the faster connection before draining the old one.

Use `ordered` for deterministic examples and `latency` for real multi-edge deployments.

## Local Discovery

```javascript
const hub = new KinopioHub({
  servers: ["wss://demo.nats.io:8443"],
  discovery: {
    enabled: true,
    manifestUrl: "https://app.example.com/.well-known/kinopio-leader.json",
    backgroundLocalProbe: true,
    localSwitchTimeoutMs: 1500,
    cacheTtlMs: 5000,
  },
});
```

Discovery connects to the configured remote servers first, then probes a manifest for a healthier local leaf. If the manifest is absent, expired, unreachable, or exposes a local WebSocket URL the client cannot connect to, the remote connection stays active.

In a browser, omitted `manifestUrl` defaults to the current origin plus `/.well-known/kinopio-leader.json`. In Node, pass a manifest URL explicitly or use `autoLeaf`.

## Node Leaf Runtime

The root `kinopio-hub` entrypoint stays browser-friendly. Node-only local leaf APIs live under `kinopio-hub/leaf`.

```javascript
import { startLeafNode, enableAutoLeaf } from "kinopio-hub/leaf";
```

Manual leaf startup:

```javascript
const leaf = await startLeafNode({
  discoveryNamespace: "studio",
  backboneServers: ["wss://demo.nats.io:8443"],
  webSocketTls: false,
});

console.log(leaf.status().websocketUrl);
await leaf.stop();
```

LAN auto election:

```javascript
const agent = await enableAutoLeaf({
  discoveryNamespace: "studio",
  backboneServers: ["wss://demo.nats.io:8443"],
  webSocketTls: false,
});

console.log(agent.status());
await agent.stop();
```

Leaf runtime notes:

- `backboneServers` are upstream leaf remotes for the bundled `nats-server`, not root-client `wsconnect()` targets.
- With the public `wss://demo.nats.io:8443` endpoint, the examples verify local leaf startup and cleanup. The bridge can remain `"connecting"` if the public demo server does not accept leaf remote connections.
- Use one remote transport mode per leaf runtime: all `ws://`, all `wss://`, or all native leafnode URLs.
- `webSocketTls` defaults to `true`. Set it to `false` for local development when you want `ws://` plus `http://` discovery.
- When TLS is enabled without explicit PEM files, the runtime can generate a local CA and best-effort install trust on the current machine. Set `KINOPIO_SKIP_CA_TRUST_INSTALL=1` in CI or restricted environments.

## CLI

```bash
kinopio-hub --help
kinopio-hub leaf start --discovery-namespace studio --backbone-server wss://demo.nats.io:8443 --no-websocket-tls
kinopio-hub leaf auto --discovery-namespace studio --backbone-server wss://demo.nats.io:8443 --no-websocket-tls
```

The CLI wraps the same `startLeafNode()` and `enableAutoLeaf()` APIs and keeps running until interrupted.

## Run Examples

Each runnable example is self-contained and uses `wss://demo.nats.io:8443`.

```bash
node example/connection.mjs
node example/scope.mjs
node example/publish.mjs
node example/subscribe.mjs
node example/request-reply.mjs
node example/codec.mjs
node example/browser-discovery.mjs
node example/leaf-entrypoint.mjs
node example/auto-leaf.mjs
```

To run them as a smoke suite:

```bash
for file in example/*.mjs; do
  case "$file" in */_shared.mjs) continue ;; esac
  echo "==> $file"
  KINOPIO_SKIP_CA_TRUST_INSTALL=1 node "$file"
done
```

## Development

See [How_To_Dev.md](./How_To_Dev.md).

```bash
npm test
npm run test:bun
```

## License

GPL-3.0-or-later. See [LICENSE](./LICENSE).
