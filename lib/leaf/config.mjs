import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  assertNonEmptyString,
  assertOptionalBoolean,
  assertOptionalPort,
  assertOptionalPositiveNumber,
  assertOptionalString,
  assertOptionalStringArray,
  assertPlainObject,
} from "../shared/assert.mjs";
import { resolveLeafCacheRoot } from "./runtime.mjs";

export function validateLeafNodeOptions(options, label = "options") {
  assertPlainObject(options, label);
  assertNonEmptyString(options.discoveryNamespace, `${label}.discoveryNamespace`);
  assertOptionalStringArray(options.backboneServers, `${label}.backboneServers`);
  assertOptionalString(options.advertisedHostname, `${label}.advertisedHostname`);
  assertOptionalString(options.nodeId, `${label}.nodeId`);
  assertOptionalString(options.cacheDir, `${label}.cacheDir`);
  assertOptionalString(options.binaryPath, `${label}.binaryPath`);
  assertOptionalString(options.runtimeDir, `${label}.runtimeDir`);
  assertOptionalString(options.lanBindAddress, `${label}.lanBindAddress`);
  assertOptionalBoolean(options.webSocketTls, `${label}.webSocketTls`);

  if (options.ports !== undefined) {
    assertPlainObject(options.ports, `${label}.ports`);
    assertOptionalPort(options.ports.client, `${label}.ports.client`);
    assertOptionalPort(options.ports.websocket, `${label}.ports.websocket`);
    assertOptionalPort(options.ports.discovery, `${label}.ports.discovery`);
    assertOptionalPort(options.ports.monitor, `${label}.ports.monitor`);
  }

  if (options.tls !== undefined) {
    assertPlainObject(options.tls, `${label}.tls`);
    assertOptionalString(options.tls.certFile, `${label}.tls.certFile`);
    assertOptionalString(options.tls.keyFile, `${label}.tls.keyFile`);
  }
}

export function validateAutoLeafOptions(options) {
  validateLeafNodeOptions(options);
  assertOptionalPositiveNumber(options.leaderMissingGraceMs, "options.leaderMissingGraceMs");
}


export function isIpv4Address(value) {
  return typeof value === "string" && /^(\d{1,3}\.){3}\d{1,3}$/u.test(value);
}

export function isPrivateIpv4(value) {
  if (!isIpv4Address(value)) return false;
  const [first, second] = value.split(".").map(Number);
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

export function chooseLanAddress(explicitAddress) {
  if (explicitAddress) {
    return explicitAddress;
  }

  const networkInterfaces = os.networkInterfaces();
  const candidates = [];

  for (const entries of Object.values(networkInterfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const score = isPrivateIpv4(entry.address) ? 2 : 1;
      candidates.push({ address: entry.address, score });
    }
  }

  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]?.address || "127.0.0.1";
}

export async function findAvailablePort(host) {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

export async function resolveLeafPorts(portOverrides, lanBindAddress) {
  return {
    client: portOverrides?.client || await findAvailablePort("127.0.0.1"),
    websocket: portOverrides?.websocket || await findAvailablePort(lanBindAddress),
    discovery: portOverrides?.discovery || await findAvailablePort(lanBindAddress),
    monitor: portOverrides?.monitor || await findAvailablePort("127.0.0.1"),
  };
}

export async function resolveStableNodeId(customCacheDir, explicitNodeId) {
  if (explicitNodeId) {
    return {
      nodeId: explicitNodeId,
      nodeIdFile: null,
    };
  }

  const autoLeafDir = path.join(resolveLeafCacheRoot(customCacheDir), "kinopio-hub", "auto-leaf");
  const nodeIdFile = path.join(autoLeafDir, "node-id");

  try {
    const existingNodeId = (await readFile(nodeIdFile, "utf8")).trim();
    if (existingNodeId) {
      return {
        nodeId: existingNodeId,
        nodeIdFile,
      };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(autoLeafDir, { recursive: true });
  const nodeId = randomUUID();
  await writeFile(nodeIdFile, `${nodeId}\n`, "utf8");
  return {
    nodeId,
    nodeIdFile,
  };
}

export function isWebSocketTlsEnabled(options) {
  return options.webSocketTls !== false;
}

export function quoteConfigValue(value) {
  return JSON.stringify(String(value));
}

export function getBackboneTransportMode(url) {
  const protocol = new URL(url).protocol;
  if (protocol === "ws:") return "websocket";
  if (protocol === "wss:") return "websocket-tls";
  return "leafnode";
}

export function assertCompatibleBackboneServers(backboneServers) {
  const modes = new Set(backboneServers.map(getBackboneTransportMode));
  if (modes.size <= 1) {
    return;
  }

  throw new TypeError(
    "backboneServers must use one remote transport mode per leaf runtime. " +
    "Do not mix ws://, wss://, and native leafnode URLs in the same list.",
  );
}

export function renderBackboneRemoteUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol === "wss:") {
    parsed.protocol = "ws:";
  }
  return parsed.toString();
}

export function renderLeafConfig({ paths, ports, lanBindAddress, advertisedHostname, normalizedBackboneServers, webSocketTls }) {
  const lines = [
    `listen: ${quoteConfigValue(`127.0.0.1:${ports.client}`)}`,
    `http: ${quoteConfigValue(`127.0.0.1:${ports.monitor}`)}`,
    `log_file: ${quoteConfigValue(paths.logFile)}`,
    `pid_file: ${quoteConfigValue(paths.pidFile)}`,
    "",
    "websocket {",
    `  host: ${quoteConfigValue(lanBindAddress)}`,
    `  port: ${ports.websocket}`,
    `  advertise: ${quoteConfigValue(`${advertisedHostname}:${ports.websocket}`)}`,
    ...(webSocketTls
      ? [
          "  tls {",
          `    cert_file: ${quoteConfigValue(paths.certFile)}`,
          `    key_file: ${quoteConfigValue(paths.keyFile)}`,
          "  }",
        ]
      : [
          "  no_tls: true",
        ]),
    "}",
  ];

  if (normalizedBackboneServers.length > 0) {
    const needsRemoteTls = normalizedBackboneServers.every(url => getBackboneTransportMode(url) === "websocket-tls");
    const remoteUrls = normalizedBackboneServers.map(renderBackboneRemoteUrl);

    lines.push(
      "",
      "leafnodes {",
      "  remotes: [",
      "    {",
      `      urls: [${remoteUrls.map(url => quoteConfigValue(url)).join(", ")}]`,
      "      no_randomize: true",
      ...(needsRemoteTls ? ["      tls {}"] : []),
      "    }",
      "  ]",
      "  reconnect: 2s",
      "}",
    );
  }

  return `${lines.join("\n")}\n`;
}


export function createRuntimePaths(baseRuntimeDir) {
  return {
    runtimeDir: baseRuntimeDir,
    certsDir: path.join(baseRuntimeDir, "certs"),
    storeDir: path.join(baseRuntimeDir, "store"),
    runDir: path.join(baseRuntimeDir, "run"),
    logsDir: path.join(baseRuntimeDir, "logs"),
    configFile: path.join(baseRuntimeDir, "nats-leaf.conf"),
    certFile: path.join(baseRuntimeDir, "certs", "leaf-cert.pem"),
    keyFile: path.join(baseRuntimeDir, "certs", "leaf-key.pem"),
    pidFile: path.join(baseRuntimeDir, "run", "nats-server.pid"),
    logFile: path.join(baseRuntimeDir, "logs", "nats-server.log"),
  };
}

export async function createRuntimeDirectory(parentDir) {
  const baseDir = parentDir ? path.resolve(parentDir) : os.tmpdir();
  await mkdir(baseDir, { recursive: true });
  return await mkdtemp(path.join(baseDir, "kinopio-leaf-"));
}

export async function ensureRuntimeFolders(runtimePaths) {
  await mkdir(runtimePaths.certsDir, { recursive: true });
  await mkdir(runtimePaths.storeDir, { recursive: true });
  await mkdir(runtimePaths.runDir, { recursive: true });
  await mkdir(runtimePaths.logsDir, { recursive: true });
}
