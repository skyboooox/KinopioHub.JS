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

## 安装

```bash
npm install kinopio-hub
```

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
  servers: ["wss://nats.example.com:443"],
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
| servers | string[] | ["wss://demo.nats.io:8443"] | NATS服务器URL列表 |
| debug | boolean | false | 启用调试日志 |
| noEcho | boolean | false | 不接收自己发布的消息 |
| noRandomize | boolean | true | 不随机化服务器列表 |
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
| codec | {encode(data):Uint8Array, decode(bytes):any} | undefined | 自定义序列化编解码器 |
| jsonReplacer | Function | undefined | JSON.stringify 的 replacer |
| jsonReviver | Function | undefined | JSON.parse 的 reviver |

## 高级用法

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

## 许可证

GPL-3.0-or-later - 详见[LICENSE](./LICENSE)文件。
