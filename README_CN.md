# KinopioHub.JS

云原生通信框架,目标是把远程的变量和函数在本地使用

[![npm version](https://badge.fury.io/js/kinopio-hub.svg?icon=si%3Anpm)](https://www.npmjs.com/package/kinopio-hub)
![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-green)

[English](./README.md)

## 特性

- 🔍 自动值跟踪和缓存
- 🌳 层级作用域系统
- 🔄 自动重连处理
- 🛡️ 内置错误处理和重试机制
- 🧭 提供 Node-only 本地 leaf runtime、局域网自动选主、浏览器后台发现与打包 CLI

## 安装

```bash
npm install kinopio-hub
```

执行 `npm install` 时，当前包会尽力把官方 `nats-server v2.12.7` 预取到用户缓存目录，方便后续 Node-only leaf runtime 直接启动。如果你需要在安装时跳过这一步，可以设置 `KINOPIO_SKIP_NATS_SERVER_DOWNLOAD=1`。

## 快速开始

```javascript
import KinopioHub, { KINOPIO_STATE_EVENT } from 'kinopio-hub';

// 创建新实例
const hub = new KinopioHub({
  servers: ["wss://nats.example.com:443"],
  debug: true
});

// 使用作用域变量
const myScope = hub.getScope("myScope");
const myVar = myScope.getVariable("myVar");

// 发布数据
await myVar.pub({ message: "Hello!" });

// 订阅更新
await myVar.sub(data => {
  console.log("收到:", data);
});
```

## 核心概念

### KinopioHub

主客户端类，用于管理连接并提供对作用域和变量的访问。

```javascript
const hub = new KinopioHub({
  servers: ["wss://demo.nats.io:8443", "wss://demo.nats.io:4443"],
  serverSelectionMode: "latency",
  debug: true,
  noEcho: false,
  reconnectTimeout: 5000
});
```

### 作用域（Scopes）

作用域帮助将变量组织成逻辑组：

```javascript
// 获取作用域
const userScope = hub.getScope("users");

// 访问作用域中的变量
const onlineUsers = userScope.getVariable("online");
const userCount = userScope.getVariable("count");

// 动态属性访问
const onlineUsers = hub.users.online;  // 与上面等效
```

### 变量（Variables）

变量是作用域中的数据容器，支持发布、订阅和请求-响应模式：

```javascript
// 发布
await myVar.pub({ count: 42 });

// 订阅
await myVar.sub(data => {
  console.log("值已更新:", data);
});

// 请求-响应模式
const response = await myVar.req({ action: "getData" });

// 服务处理器
await myVar.serve(async (request) => {
  if (request.action === "getData") {
    return { value: "some data" };
  }
});
```

## 配置选项

| 选项 | 类型 | 默认值 | 描述 |
|--------|------|---------|-------------|
| servers | string[] | ["wss://demo.nats.io:8443", "wss://demo.nats.io:4443"] | NATS服务器URL列表 |
| debug | boolean | false | 启用调试日志 |
| noEcho | boolean | false | 不接收自己发布的消息 |
| serverSelectionMode | "ordered" \| "random" \| "latency" | "latency" | KinopioHub 在连接前如何排列多个候选服务器 |
| maxReconnectAttempts | number | -1 | 最大重连尝试次数（-1 表示无限） |
| waitOnFirstConnect | boolean | true | 等待首次连接 |
| reconnectTimeout | number | 5000 | 重连超时时间（毫秒） |
| reconnectTimeWait | number | 500 | 重连间隔时间（毫秒） |
| pingInterval | number | 3000 | ping 间隔（毫秒） |
| maxPingOut | number | 3 | 未响应 ping 的最大次数 |
| timeout | number | 3000 | 操作超时时间（毫秒） |
| healthReport | number | 5000 | 健康报告间隔（毫秒） |
| autoConnect | boolean | true | 创建 hub 后立即开始连接 |
| autoRetry | boolean | true | 连接失败自动重试 |
| retryDelay | number | 1000 | 初始重试延迟（毫秒） |
| retryBackoffFactor | number | 1.5 | 退避倍数 |
| maxRetryDelay | number | 30000 | 最大重试延迟（毫秒） |
| discovery | `{ enabled?, manifestUrl?, backgroundLocalProbe?, localSwitchTimeoutMs?, cacheTtlMs? }` | undefined | 浏览器侧本地 leaf 后台探测与热切换配置 |
| codec | {encode(data):Uint8Array, decode(bytes):any} | undefined | 自定义序列化编解码器 |
| jsonReplacer | Function | undefined | JSON.stringify 的 replacer |
| jsonReviver | Function | undefined | JSON.parse 的 reviver |

兼容性方面，如果没有设置 `serverSelectionMode`，运行时仍会接受旧的 `noRandomize` 作为兼容别名，但它已经不是主要公开配置项。

当 `discovery.enabled === true` 时，浏览器友好的根入口现在已经会执行后台本地 leaf 探测。默认策略仍然是“先连用户配置的远端 servers，再在后台静默探测本地 leaf”；探测失败不会阻塞首连。

### 服务器选择模式

- `ordered`：首次连接和底层 NATS 后续重连都保持输入顺序。
- `random`：每次全新连接或手动重连前先重新打乱候选服务器顺序，并在该次连接生命周期内保持这份顺序稳定。
- `latency`：默认模式。每次全新连接或手动重连前，KinopioHub 会并行探测所有配置服务器，并按 NATS 客户端 `flush()` / `rtt()` 语义测量 RTT，优先选择 RTT 更低的健康节点。探测失败的节点会保留在候选列表尾部并维持原始输入顺序；如果全部探测失败，则回退到原始输入顺序继续连接。成功进入 `latency` 模式连接后，KinopioHub 还会每 10 分钟做一次后台复测；只有发现新的健康节点至少快 30ms 时，才会先在新连接上重建值跟踪、逻辑订阅和服务，再 drain 旧连接完成热切换。在这段很短的双订阅窗口里，普通订阅回调可能出现极少量重复。

### 典型模式示例

```javascript
// 固定主备顺序
const orderedHub = new KinopioHub({
  servers: ["wss://primary.example.com:443", "wss://backup.example.com:443"],
  serverSelectionMode: "ordered"
});

// 每次全新连接周期都重新打乱候选顺序
const randomHub = new KinopioHub({
  servers: ["wss://a.example.com:443", "wss://b.example.com:443"],
  serverSelectionMode: "random"
});

// 优先最低延时节点，并在后台自动迁移
const latencyHub = new KinopioHub({
  servers: ["wss://edge-a.example.com:443", "wss://edge-b.example.com:443"],
  serverSelectionMode: "latency"
});
```

### 浏览器本地发现

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

- 如果没有显式传入 `manifestUrl`，默认会使用当前页面 origin 下的 `/.well-known/kinopio-leader.json`。
- 浏览器首次连接仍然先使用当前配置的远端 servers，然后才会在后台拉取 discovery manifest。
- 如果 manifest 暴露了可用的本地 `wssUrl`，并且浏览器也确实成功建立了这条本地连接，KinopioHub 会先在新连接上重建值跟踪、订阅和服务，再 drain 旧连接，把当前会话热切换到本地 leaf。
- 如果后续本地 leaf 消失，KinopioHub 会自动回退到当前配置的远端 servers，并继续在后台等待下一次可用的本地 leader。
- 如果 manifest 拉取失败，或者浏览器无法信任 / 连接这个本地 `wss`，当前远端会话会保持不变。
- 其他设备上的浏览器仍然要遵守正常 TLS 信任规则。在 leader 机器本机安装信任，优先帮助的是 leader 本机浏览器，而不会自动让所有远端浏览器都信任这张本地 CA。

### 运行边界

- 浏览器会话本身不是 leaf node，也不能直接拉起 `nats-server`。
- 能运行 Node 的设备需要通过 `enableAutoLeaf()` 或 `kinopio-hub leaf auto` 参与发现与选主。
- 同一个 `discoveryNamespace` 里如果已经有健康 leader，新加入的 capable device 只会停留在 `following-leader`，不会重复启动本地 leaf。
- 在开放多设备浏览器环境下，本地优先仍然只是增强路径，因为每台浏览器设备都仍然需要各自满足 TLS 信任条件。

## 高级用法

### 打包 CLI

安装后，当前包会暴露一个 `kinopio-hub` CLI：

```bash
kinopio-hub --help
kinopio-hub leaf start --discovery-namespace studio
kinopio-hub leaf auto --discovery-namespace studio --backbone-server nats://upstream.example.com:7422
```

- `kinopio-hub leaf start` 是 `startLeafNode()` 的手动运行时封装。
- `kinopio-hub leaf auto` 是 `enableAutoLeaf()` 的自动选主封装。
- 这两个命令都会持续运行到你按下 `Ctrl+C`，启动时先打印一份状态快照；如果你需要纯机器可读输出，可以额外传 `--json`。
- CLI 复用和 Node-only leaf API 相同的本地 CA / 信任安装行为，同样支持在 CI 或受限环境里设置 `KINOPIO_SKIP_CA_TRUST_INSTALL=1`。

### Node-only Leaf 子路径

当前包已经提供了一个只面向 Node 宿主的本地 leaf 子路径：

```javascript
import { enableAutoLeaf, startLeafNode } from "kinopio-hub/leaf";
```

`enableAutoLeaf()` 现在已经是阶段三的高层入口。它会加入一个局域网级别的协调 namespace，复用稳定缓存下来的 `nodeId`，通过 UDP 组播和 mDNS 发现现有健康 leaf，并且只在当前 namespace 缺少主节点时才启动本地 leaf。

```javascript
import { enableAutoLeaf } from "kinopio-hub/leaf";

const autoLeaf = await enableAutoLeaf({
  discoveryNamespace: "studio",
  backboneServers: ["nats://upstream.example.com:7422"],
  leaderMissingGraceMs: 10_000,
});

console.log(autoLeaf.status());

// 稍后停止:
await autoLeaf.stop();
```

`startLeafNode()` 继续保留为低层手动 runtime 入口。它会解析缓存里的 `nats-server` 二进制、写临时配置、启动本地 leaf server、暴露 WSS 和 HTTPS discovery manifest，并返回带有 `wssUrl`、`discoveryUrl`、`clientUrl`、`monitorUrl`、`status()`、`stop()` 的 handle。

```javascript
import { startLeafNode } from "kinopio-hub/leaf";

const leaf = await startLeafNode({
  discoveryNamespace: "studio",
  backboneServers: ["nats://upstream.example.com:7422"],
});

console.log(leaf.status());
await leaf.stop();
```

Leaf 运行时说明：

- `backboneServers` 会被归一化为 NATS leaf remote URL，并且是可选项。即使上游不可达，`startLeafNode()` 也可以先在本地启动成功，此时 `status().bridgeState` 会保持 `"connecting"`。
- `enableAutoLeaf()` 会保证同一个 `discoveryNamespace` 里只保留一个主 leaf。当前已经存在健康主节点时，新加入的 capable device 只会停留在 `following-leader`，不会重复拉起本地 leaf。
- 当前主节点失联后，跟随节点会先等待 `leaderMissingGraceMs` 再参与接管。默认恢复窗口是 10 秒。
- 当 RTT 可测时，选主优先级固定为 RTT 更低者优先、RTT 可测优先于不可测、最后再按稳定 `nodeId` 决胜；健康主节点只有在对手连续多个周期都领先至少 50ms 时才会被抢主。
- 本地 NATS client listener 默认只绑定回环地址，而 WSS 和 discovery 默认绑定到自动探测到的局域网地址。
- 如果你没有提供 `tls.certFile` 和 `tls.keyFile`，当前 leaf runtime 会先自动生成可复用的本地根 CA，再为当前 `advertisedHostname` 签发短期 leaf 证书，并 best-effort 尝试把这张 CA 安装到 leader 设备本机的信任链。
- `status().tls` 会明确报告当前是使用外部 PEM 还是自动生成的本地 CA，以及 CA 信任安装结果是 `installed`、`skipped`、`failed` 还是 `external`。
- 自动信任安装本身就是 best-effort 能力。对于开放多设备浏览器场景，即使 leader 本机已信任，本地 `wss` 仍然可能被其他未安装 CA 的设备拒绝。
- 如果你在 CI、自动化脚本或受限环境里不希望修改信任链，可以设置 `KINOPIO_SKIP_CA_TRUST_INSTALL=1`。
- 根入口 `kinopio-hub` 继续保持浏览器友好，不会引入 Node-only 的进程控制逻辑。
- 当前仓库内可直接参考的示例：
  [example/leaf-entrypoint.mjs](./example/leaf-entrypoint.mjs)，
  [example/auto-leaf.mjs](./example/auto-leaf.mjs)，
  [example/browser-discovery.mjs](./example/browser-discovery.mjs)

### 连接管理

```javascript
// 等待连接
await hub.connected();

// 手动重连
await hub.reconnect();

// 清理资源
await hub.dispose();
```

### 错误处理

```javascript
try {
  await myVar.pub(data);
} catch (error) {
  console.error("发布失败:", error);
}

// 启用调试日志
const hub = new KinopioHub({ debug: true });

// 监听状态变化
const stop = hub.onStateChange((state) => console.log('state:', state));
// 或使用事件常量
// event.on(KINOPIO_STATE_EVENT, listener)
stop();
```

在测试、SSR 初始化或需要手动控制连接时，可以关闭自动连接：

```javascript
const hub = new KinopioHub({ autoConnect: false });
await hub.connect();
```

### 服务模式

```javascript
// 服务端
await myVar.serve(async (request) => {
  if (request.action === "increment") {
    return { value: currentValue + 1 };
  }
  throw new Error("未知操作");
});

// 客户端
const response = await myVar.req({ action: "increment" });
console.log(response.value);
```

## 示例

查看[示例目录](./example)获取更多详细示例。

> 关于默认服务器：默认的 `servers` 指向 NATS 的演示地址，仅用于开发/测试。生产环境请配置自有的安全 NATS 服务端。

## 开发

参见[How_To_Dev.md](./How_To_Dev.md)获取开发指南。

常用验证命令：

```bash
npm test
npm run test:bun
```

## 许可证

GPL-3.0-or-later - 详见[LICENSE](./LICENSE)文件。
