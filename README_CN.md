# KinopioHub.JS

KinopioHub.JS 是一个同时适合浏览器和 Node 的 JavaScript 客户端，用来把 NATS subject 当成本地变量、订阅和请求处理器使用。

[![npm version](https://badge.fury.io/js/kinopio-hub.svg?icon=si%3Anpm)](https://www.npmjs.com/package/kinopio-hub)
![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-green)

[English](./README.md)

## 安装

```bash
npm install kinopio-hub
```

安装时，包会尽力把官方 `nats-server v2.12.7` 下载到用户缓存目录，方便 Node-only leaf runtime 后续直接启动。如果安装阶段不希望预取，可以设置 `KINOPIO_SKIP_NATS_SERVER_DOWNLOAD=1`。

## 快速开始

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

重要提示：`KinopioHub` 支持本地 discovery，并且在非浏览器 Node 运行时里可以自动启动本地 leaf。本仓库示例在演示公共 demo server 时都会显式设置 `autoLeaf: false` 和 `discovery: false`，确保所有流量都走 `wss://demo.nats.io:8443`。

## 功能索引

| 功能 | API | 示例 |
| --- | --- | --- |
| 连接生命周期 | `connect()`, `connected()`, `reconnect()`, `dispose()`, `onStateChange()` | [example/connection.mjs](./example/connection.mjs) |
| 作用域与变量 | `getScope()`, `getVariable()`, 动态 `hub.scope.variable` 访问 | [example/scope.mjs](./example/scope.mjs) |
| 发布 | `variable.pub()` | [example/publish.mjs](./example/publish.mjs) |
| 订阅 | `variable.sub()` 和订阅 handle | [example/subscribe.mjs](./example/subscribe.mjs) |
| 请求/响应 | `variable.serve()`, `variable.req()`, `hub.request()` | [example/request-reply.mjs](./example/request-reply.mjs) |
| 序列化 | `codec`, `serializeData()`, `deserializeData()` | [example/codec.mjs](./example/codec.mjs) |
| 浏览器本地发现 | `discovery` 选项和 manifest 探测 | [example/browser-discovery.mjs](./example/browser-discovery.mjs) |
| 手动本地 leaf | `kinopio-hub/leaf` 的 `startLeafNode()` | [example/leaf-entrypoint.mjs](./example/leaf-entrypoint.mjs) |
| 局域网自动 leaf | `kinopio-hub/leaf` 的 `enableAutoLeaf()` | [example/auto-leaf.mjs](./example/auto-leaf.mjs) |

## 核心 API

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

根客户端的 `servers` 只接受 `ws://` 或 `wss://` URL。测试或示例里如果希望服务器不可用时快速失败，可以设置 `autoRetry: false`。

### 作用域

作用域是你显式管理的 subject 前缀，变量会再追加一个 subject 段。

```javascript
const devices = hub.getScope("devices");
const battery = devices.getVariable("battery");

console.log(battery.subject); // devices.battery

const sameVariable = hub.devices.battery;
```

动态属性访问很方便；当名称来自变量或用户输入时，`getScope()` 和 `getVariable()` 更清晰。

### 变量

```javascript
const temperature = hub.getScope("room").getVariable("temperature");

await temperature.pub({ celsius: 22.5 });

const sub = await temperature.sub((value, message) => {
  console.log(value, message.subject);
});

console.log(temperature.value);

sub.unsubscribe();
```

每个变量会跟踪本地看到的最新值。同一个变量连续发布完全相同的字节内容时会去重。

### 请求/响应

```javascript
const calculator = hub.getScope("math").getVariable("calculator");

const service = await calculator.serve(async (request) => {
  return { result: request.a + request.b };
});

const response = await calculator.req({ a: 2, b: 3 });
console.log(response.result);

service.unsubscribe();
```

如果你已经有 subject 字符串，也可以使用 `hub.request(subject, data)`。

## 配置项

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `servers` | `string[]` | `["wss://demo.nats.io:8443", "wss://demo.nats.io:4443"]` | 根客户端 WebSocket 端点。 |
| `debug` | `boolean` | `false` | 输出连接、重试、discovery 和热切换日志。 |
| `noEcho` | `boolean` | `false` | 设置为 `true` 后不接收同一连接自己发布的消息。 |
| `serverSelectionMode` | `"ordered" \| "random" \| "latency"` | `"latency"` | 全新连接前如何排列候选服务器。 |
| `autoConnect` | `boolean` | `true` | 设置为 `false` 后需要手动调用 `connect()`。 |
| `autoRetry` | `boolean` | `true` | 设置为 `false` 后连接失败会快速抛错。 |
| `timeout` | `number` | `3000` | 操作超时时间，单位毫秒。 |
| `retryDelay` | `number` | `1000` | 带 jitter/backoff 之前的初始重试延迟。 |
| `retryBackoffFactor` | `number` | `1.5` | 重试延迟倍数。 |
| `maxRetryDelay` | `number` | `30000` | 重试延迟上限。 |
| `discovery` | `false \| object` | `{ enabled: true }` | 基于 manifest 的本地 leaf 探测与热切换。 |
| `autoLeaf` | `boolean \| object` | Node 中启用，浏览器中禁用 | 非浏览器 Node 运行时自动启动本地 leaf。 |
| `codec` | `{ encode, decode }` | `undefined` | 自定义二进制序列化。 |
| `jsonReplacer` / `jsonReviver` | functions | `undefined` | JSON fallback 的定制入口。 |

如果没有设置 `serverSelectionMode`，旧的 `noRandomize` 仍作为兼容别名保留。新代码优先使用 `serverSelectionMode`。

## 服务器选择

- `ordered`：保持输入顺序。
- `random`：每次全新连接生命周期开始前打乱候选列表。
- `latency`：探测候选节点并优先选择 RTT 更低的节点，之后也会周期性复测。如果发现另一个健康节点至少快 30ms，KinopioHub 可以先在新连接上重建值跟踪、订阅和服务，再 drain 旧连接。

示例和测试建议用 `ordered` 保持可预测；真实多边缘部署可以用 `latency`。

## 本地 Discovery

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

Discovery 会先连接配置里的远端服务器，然后再探测 manifest 里是否有更合适的本地 leaf。如果 manifest 不存在、已过期、不可达，或者暴露的本地 WebSocket URL 当前无法连接，已有远端连接会保持不变。

浏览器中省略 `manifestUrl` 时，默认使用当前 origin 下的 `/.well-known/kinopio-leader.json`。Node 中需要显式传入 manifest URL，或者使用 `autoLeaf`。

## Node Leaf Runtime

根入口 `kinopio-hub` 保持浏览器友好。只面向 Node 的本地 leaf API 位于 `kinopio-hub/leaf`。

```javascript
import { startLeafNode, enableAutoLeaf } from "kinopio-hub/leaf";
```

手动启动 leaf：

```javascript
const leaf = await startLeafNode({
  discoveryNamespace: "studio",
  backboneServers: ["wss://demo.nats.io:8443"],
  webSocketTls: false,
});

console.log(leaf.status().websocketUrl);
await leaf.stop();
```

局域网自动选主：

```javascript
const agent = await enableAutoLeaf({
  discoveryNamespace: "studio",
  backboneServers: ["wss://demo.nats.io:8443"],
  webSocketTls: false,
});

console.log(agent.status());
await agent.stop();
```

Leaf runtime 注意点：

- `backboneServers` 是内置 `nats-server` 使用的上游 leaf remote，不是根客户端 `wsconnect()` 的直接目标。
- 使用公共 `wss://demo.nats.io:8443` 时，示例验证的是本地 leaf 能启动并清理；如果公共 demo server 不接受 leaf remote 连接，bridge 可能保持 `"connecting"`。
- 同一个 leaf runtime 内只能使用一种 remote transport：全 `ws://`、全 `wss://`，或全原生 leafnode URL。
- `webSocketTls` 默认是 `true`。本地开发如果希望暴露 `ws://` 和 `http://` discovery，可以设置为 `false`。
- TLS 开启且未提供 PEM 文件时，runtime 可以生成本地 CA，并尽力把信任安装到当前机器。CI 或受限环境中可设置 `KINOPIO_SKIP_CA_TRUST_INSTALL=1`。

## CLI

```bash
kinopio-hub --help
kinopio-hub leaf start --discovery-namespace studio --backbone-server wss://demo.nats.io:8443 --no-websocket-tls
kinopio-hub leaf auto --discovery-namespace studio --backbone-server wss://demo.nats.io:8443 --no-websocket-tls
```

CLI 封装的是同一套 `startLeafNode()` 和 `enableAutoLeaf()` API，并会持续运行到你手动中断。

## 运行示例

每个可运行示例都是独立的，并且都使用 `wss://demo.nats.io:8443`。

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

也可以作为 smoke suite 逐个执行：

```bash
for file in example/*.mjs; do
  case "$file" in */_shared.mjs) continue ;; esac
  echo "==> $file"
  KINOPIO_SKIP_CA_TRUST_INSTALL=1 node "$file"
done
```

## 开发

参见 [How_To_Dev.md](./How_To_Dev.md)。

```bash
npm test
npm run test:bun
```

## 许可证

GPL-3.0-or-later。详见 [LICENSE](./LICENSE)。
