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

## Installation

```bash
npm install kinopio-hub
```

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
  servers: ["wss://nats.example.com:443"],
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
| servers | string[] | ["wss://demo.nats.io:8443"] | List of NATS server URLs |
| debug | boolean | false | Enable debug logging |
| noEcho | boolean | false | Don't receive own published messages |
| noRandomize | boolean | true | Don't randomize server list |
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
| codec | {encode(data):Uint8Array, decode(bytes):any} | undefined | Custom codec for serialization |
| jsonReplacer | Function | undefined | JSON.stringify replacer |
| jsonReviver | Function | undefined | JSON.parse reviver |

## Advanced Usage

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

## License

GPL-3.0-or-later - see [LICENSE](./LICENSE) file for details.
