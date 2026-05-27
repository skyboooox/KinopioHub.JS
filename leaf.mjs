import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import dgram from "node:dgram";
import { access } from "node:fs/promises";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import {
  NATS_SERVER_VERSION,
  WELL_KNOWN_MANIFEST_PATH,
  ensureNatsServerBinary,
  normalizeBackboneServerUrl,
  resolveLeafCacheRoot,
  runCommand,
} from "./leaf-runtime.mjs";
import {
  DEFAULT_BACKBONE_PROBE_INTERVAL_MS,
  DEFAULT_COORDINATION_HEARTBEAT_MS,
  DEFAULT_DISCOVERY_QUERY_INTERVAL_MS,
  DEFAULT_DISCOVERY_SETTLE_MS,
  DEFAULT_LEADER_LEASE_MS,
  DEFAULT_LEADER_MISSING_GRACE_MS,
  PREEMPTION_CONFIRMATION_CYCLES,
  chooseBestLeader,
  chooseElectionWinner,
  compareLeaderRecords,
  isLeaseActive,
  makeLeaseExpiresAt,
  normalizeEpoch,
  normalizeFiniteRtt,
  shouldAttemptPreemption,
} from "./leaf-election.mjs";
import {
  buildMdnsAnnouncementPacket,
  buildMdnsQueryPacket,
  extractKinopioLeafManifests,
  parseMdnsPacket,
} from "./leaf-mdns.mjs";

const DEFAULT_LEAF_READY_TIMEOUT_MS = 20_000;
const DEFAULT_BRIDGE_POLL_INTERVAL_MS = 1_000;
const DEFAULT_DISCOVERY_MANIFEST_TTL_MS = 5_000;
const AUTO_AGENT_TICK_MS = 250;
const AUTO_LEAF_RETRY_DELAY_MS = 2_000;
const AUTO_COORDINATION_GROUP = "239.255.42.99";
const AUTO_COORDINATION_PORT = 45_217;
const AUTO_MDNS_GROUP = "224.0.0.251";
const AUTO_MDNS_PORT = 5_353;
const AUTO_MDNS_TTL_SECONDS = Math.max(1, Math.ceil(DEFAULT_LEADER_LEASE_MS / 1_000));
const AUTO_COORDINATION_STALE_MS = DEFAULT_LEADER_LEASE_MS * 2;
const AUTO_PROTOCOL_VERSION = 1;
const GENERATED_CA_VALIDITY_DAYS = 3650;
const GENERATED_LEAF_CERT_VALIDITY_DAYS = 30;
const TRUST_INSTALL_COMMAND_TIMEOUT_MS = 8_000;

const sharedMulticastBuses = new Map();

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertOptionalString(value, label) {
  if (value === undefined) return;
  assertNonEmptyString(value, label);
}

function assertOptionalPositiveNumber(value, label) {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive number`);
  }
}

function assertOptionalBoolean(value, label) {
  if (value === undefined) return;
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
}

function assertOptionalPort(value, label) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new TypeError(`${label} must be an integer port between 1 and 65535`);
  }
}

function assertOptionalStringArray(value, label) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.trim() === "")) {
    throw new TypeError(`${label} must be an array of non-empty strings`);
  }
}

function assertNodeRuntime(apiName) {
  const isNode =
    typeof process !== "undefined" &&
    process?.versions !== undefined &&
    typeof process.versions.node === "string";

  if (!isNode) {
    throw new Error(`${apiName} is only available from a Node-capable runtime via the "kinopio-hub/leaf" entrypoint`);
  }
}

function validateLeafNodeOptions(options, label = "options") {
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

function validateAutoLeafOptions(options) {
  validateLeafNodeOptions(options);
  assertOptionalPositiveNumber(options.leaderMissingGraceMs, "options.leaderMissingGraceMs");
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === "string" && item.trim() !== "") : [];
}

function cloneManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    return null;
  }

  return Object.freeze({
    ...manifest,
    fallbackServers: normalizeStringArray(manifest.fallbackServers),
  });
}

function mapAutoLeafRole(stateName) {
  if (stateName === "leader") return "leader";
  if (stateName === "following-leader") return "follower";
  if (stateName === "stopped") return "stopped";
  return "candidate";
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isIpv4Address(value) {
  return typeof value === "string" && /^(\d{1,3}\.){3}\d{1,3}$/u.test(value);
}

function isPrivateIpv4(value) {
  if (!isIpv4Address(value)) return false;
  const [first, second] = value.split(".").map(Number);
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function chooseLanAddress(explicitAddress) {
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

async function findAvailablePort(host) {
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

async function resolveLeafPorts(portOverrides, lanBindAddress) {
  return {
    client: portOverrides?.client || await findAvailablePort("127.0.0.1"),
    websocket: portOverrides?.websocket || await findAvailablePort(lanBindAddress),
    discovery: portOverrides?.discovery || await findAvailablePort(lanBindAddress),
    monitor: portOverrides?.monitor || await findAvailablePort("127.0.0.1"),
  };
}

async function resolveStableNodeId(customCacheDir, explicitNodeId) {
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

function resolveBackboneProbeTarget(url) {
  const parsed = new URL(url);
  let port = parsed.port ? Number(parsed.port) : 4_222;
  if (!parsed.port && parsed.protocol === "ws:") {
    port = 80;
  } else if (!parsed.port && parsed.protocol === "wss:") {
    port = 443;
  } else if (!parsed.port && (parsed.protocol === "nats-leaf:" || parsed.protocol === "tls:")) {
    port = 7_422;
  }

  return {
    host: parsed.hostname,
    port,
  };
}

function isWebSocketTlsEnabled(options) {
  return options.webSocketTls !== false;
}

async function measureTcpConnectRtt({ host, port }, timeoutMs = 1_500) {
  const startedAt = performance.now();

  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const cleanup = () => {
      socket.removeAllListeners();
    };
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`Timed out connecting to ${host}:${port}`));
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timeout);
      cleanup();
      socket.end();
      resolve(Math.max(0, Math.round(performance.now() - startedAt)));
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      cleanup();
      socket.destroy();
      reject(error);
    });
  });
}

async function measureBackboneRtt(backboneServers) {
  if (!Array.isArray(backboneServers) || backboneServers.length === 0) {
    return null;
  }

  const samples = await Promise.allSettled(
    backboneServers.map(async (url) => {
      const target = resolveBackboneProbeTarget(url);
      return await measureTcpConnectRtt(target);
    }),
  );

  const successfulSamples = samples
    .filter(result => result.status === "fulfilled" && Number.isFinite(result.value))
    .map(result => result.value);

  if (successfulSamples.length === 0) {
    return null;
  }

  return Math.min(...successfulSamples);
}

function createDisabledBus(error = null) {
  return {
    available: false,
    error: error ? toErrorMessage(error) : null,
    subscribe() {
      return () => {};
    },
    async send() {
      return false;
    },
    async release() {},
  };
}

function createMulticastBus(name, { groupAddress, port }) {
  const socket = dgram.createSocket({
    type: "udp4",
    reuseAddr: true,
  });

  const bus = {
    name,
    groupAddress,
    port,
    socket,
    subscribers: new Set(),
    refCount: 0,
    ready: null,
  };

  socket.on("message", (message, remoteInfo) => {
    for (const subscriber of [...bus.subscribers]) {
      try {
        subscriber(message, remoteInfo);
      } catch {}
    }
  });

  bus.ready = new Promise((resolve, reject) => {
    const handleReady = () => {
      try {
        socket.addMembership(groupAddress);
        socket.setBroadcast(false);
        socket.setMulticastLoopback(true);
        socket.setMulticastTTL(255);
        socket.unref?.();
        resolve();
      } catch (error) {
        reject(error);
      }
    };

    socket.once("error", reject);
    socket.bind(port, handleReady);
  }).catch(async (error) => {
    await new Promise(resolve => socket.close(() => resolve()));
    throw error;
  });

  return bus;
}

async function acquireSharedMulticastBus(name, options) {
  let bus = sharedMulticastBuses.get(name);
  if (!bus) {
    bus = createMulticastBus(name, options);
    sharedMulticastBuses.set(name, bus);
  }

  try {
    await bus.ready;
  } catch (error) {
    sharedMulticastBuses.delete(name);
    if (options.optional) {
      return createDisabledBus(error);
    }
    throw error;
  }

  bus.refCount += 1;
  let released = false;

  return {
    available: true,
    subscribe(listener) {
      bus.subscribers.add(listener);
      return () => {
        bus.subscribers.delete(listener);
      };
    },
    async send(payload) {
      await bus.ready;
      return await new Promise((resolve, reject) => {
        bus.socket.send(payload, bus.port, bus.groupAddress, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(true);
        });
      });
    },
    async release() {
      if (released) return;
      released = true;
      bus.refCount -= 1;
      if (bus.refCount > 0) {
        return;
      }

      sharedMulticastBuses.delete(name);
      await new Promise(resolve => bus.socket.close(() => resolve()));
    },
  };
}

function quoteConfigValue(value) {
  return JSON.stringify(String(value));
}

function getBackboneTransportMode(url) {
  const protocol = new URL(url).protocol;
  if (protocol === "ws:") return "websocket";
  if (protocol === "wss:") return "websocket-tls";
  return "leafnode";
}

function assertCompatibleBackboneServers(backboneServers) {
  const modes = new Set(backboneServers.map(getBackboneTransportMode));
  if (modes.size <= 1) {
    return;
  }

  throw new TypeError(
    "backboneServers must use one remote transport mode per leaf runtime. " +
    "Do not mix ws://, wss://, and native leafnode URLs in the same list.",
  );
}

function renderBackboneRemoteUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol === "wss:") {
    parsed.protocol = "ws:";
  }
  return parsed.toString();
}

function renderLeafConfig({ paths, ports, lanBindAddress, advertisedHostname, normalizedBackboneServers, webSocketTls }) {
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
      "  reconnect: 2",
      "}",
    );
  }

  return `${lines.join("\n")}\n`;
}

function createLeafSecurityPaths(customCacheDir) {
  const securityDir = path.join(resolveLeafCacheRoot(customCacheDir), "kinopio-hub", "leaf-ca");
  return {
    securityDir,
    caCertFile: path.join(securityDir, "kinopio-leaf-root-ca.pem"),
    caKeyFile: path.join(securityDir, "kinopio-leaf-root-ca-key.pem"),
    caSerialFile: path.join(securityDir, "kinopio-leaf-root-ca.srl"),
    trustStateFile: path.join(securityDir, "kinopio-leaf-root-ca-trust.json"),
    linuxSystemCaFile: "/usr/local/share/ca-certificates/kinopio-hub-local-leaf-ca.crt",
  };
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function computeFileSha256(filePath) {
  const contents = await readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

function buildLeafTlsAltNames(advertisedHostname, lanBindAddress) {
  const altNames = [
    `IP:${lanBindAddress}`,
    "IP:127.0.0.1",
    "DNS:localhost",
  ];

  if (!isIpv4Address(advertisedHostname)) {
    altNames.unshift(`DNS:${advertisedHostname}`);
  } else {
    altNames.unshift(`IP:${advertisedHostname}`);
  }

  const hostName = os.hostname();
  if (hostName && hostName !== advertisedHostname && !hostName.includes(" ")) {
    altNames.push(`DNS:${hostName}`);
  }

  return altNames;
}

function buildLeafOpenSslConfig({ commonName, altNames }) {
  return [
    "[req]",
    "distinguished_name = req_distinguished_name",
    "req_extensions = v3_req",
    "prompt = no",
    "",
    "[req_distinguished_name]",
    `CN = ${commonName}`,
    "",
    "[v3_req]",
    "basicConstraints = CA:FALSE",
    "keyUsage = critical, digitalSignature, keyEncipherment",
    "extendedKeyUsage = serverAuth",
    `subjectAltName = ${altNames.join(",")}`,
    "",
  ].join("\n");
}

async function readTrustState(trustStateFile) {
  try {
    return JSON.parse(await readFile(trustStateFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

async function writeTrustState(trustStateFile, trustState) {
  await writeFile(trustStateFile, `${JSON.stringify(trustState, null, 2)}\n`, "utf8");
}

async function ensureGeneratedLeafCertificateAuthority(securityPaths) {
  await mkdir(securityPaths.securityDir, { recursive: true });

  const hasCaCert = await fileExists(securityPaths.caCertFile);
  const hasCaKey = await fileExists(securityPaths.caKeyFile);
  if (hasCaCert && hasCaKey) {
    return {
      caCertFile: securityPaths.caCertFile,
      caKeyFile: securityPaths.caKeyFile,
      generated: false,
    };
  }

  try {
    await runCommand("openssl", [
      "req",
      "-x509",
      "-nodes",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-days",
      String(GENERATED_CA_VALIDITY_DAYS),
      "-subj",
      "/CN=KinopioHub Local Leaf Root CA",
      "-keyout",
      securityPaths.caKeyFile,
      "-out",
      securityPaths.caCertFile,
    ]);
  } catch (error) {
    throw new Error(
      `Unable to auto-generate the local KinopioHub root CA. ` +
      `Ensure "openssl" is available in PATH or provide options.tls.certFile/keyFile manually. ` +
      `Original error: ${error.stderr || error.message}`,
    );
  }

  return {
    caCertFile: securityPaths.caCertFile,
    caKeyFile: securityPaths.caKeyFile,
    generated: true,
  };
}

function buildTrustStatus({
  state,
  strategy = null,
  detail = null,
  attempted = false,
  requiresUserAction = false,
  platform = process.platform,
}) {
  return {
    state,
    platform,
    strategy,
    detail,
    attempted,
    requiresUserAction,
  };
}

async function maybeInstallGeneratedCaTrust(securityPaths, caCertFile) {
  const certificateFingerprint = await computeFileSha256(caCertFile);
  const cachedTrustState = await readTrustState(securityPaths.trustStateFile);
  if (
    cachedTrustState?.state === "installed" &&
    cachedTrustState?.fingerprint === certificateFingerprint &&
    cachedTrustState?.platform === process.platform
  ) {
    return buildTrustStatus({
      state: "installed",
      strategy: cachedTrustState.strategy || null,
      detail: cachedTrustState.detail || null,
      attempted: false,
      requiresUserAction: false,
    });
  }

  if (process.env.KINOPIO_SKIP_CA_TRUST_INSTALL === "1") {
    return buildTrustStatus({
      state: "skipped",
      strategy: "env-skip",
      detail: "Skipped CA trust installation because KINOPIO_SKIP_CA_TRUST_INSTALL=1.",
      attempted: false,
      requiresUserAction: false,
    });
  }

  let trustStatus;

  if (process.platform === "darwin") {
    if (!process.stdin?.isTTY && !process.stdout?.isTTY) {
      trustStatus = buildTrustStatus({
        state: "skipped",
        strategy: "security add-trusted-cert",
        detail: "Skipped automatic CA trust installation in a non-interactive macOS session.",
        attempted: false,
        requiresUserAction: true,
      });
    } else {
      try {
        await runCommand(
          "security",
          [
            "add-trusted-cert",
            "-r",
            "trustRoot",
            "-p",
            "ssl",
            "-k",
            path.join(os.homedir(), "Library", "Keychains", "login.keychain-db"),
            caCertFile,
          ],
          { timeoutMs: TRUST_INSTALL_COMMAND_TIMEOUT_MS },
        );
        trustStatus = buildTrustStatus({
          state: "installed",
          strategy: "security add-trusted-cert",
          detail: "Added the generated CA to the current user's login keychain trust settings for SSL.",
          attempted: true,
          requiresUserAction: false,
        });
      } catch (error) {
        const detail = error.stderr || error.message;
        const requiresUserAction =
          error.code === "ETIMEDOUT" ||
          /interaction|denied|authorization|user interaction/i.test(detail);
        trustStatus = buildTrustStatus({
          state: requiresUserAction ? "skipped" : "failed",
          strategy: "security add-trusted-cert",
          detail,
          attempted: true,
          requiresUserAction,
        });
      }
    }
  } else if (process.platform === "win32") {
    try {
      await runCommand(
        "certutil",
        ["-user", "-addstore", "Root", caCertFile],
        { timeoutMs: TRUST_INSTALL_COMMAND_TIMEOUT_MS },
      );
      trustStatus = buildTrustStatus({
        state: "installed",
        strategy: "certutil -user -addstore Root",
        detail: "Added the generated CA to the current user's trusted root store.",
        attempted: true,
        requiresUserAction: false,
      });
    } catch (error) {
      trustStatus = buildTrustStatus({
        state: "failed",
        strategy: "certutil -user -addstore Root",
        detail: error.stderr || error.message,
        attempted: true,
        requiresUserAction: false,
      });
    }
  } else if (process.platform === "linux") {
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      trustStatus = buildTrustStatus({
        state: "skipped",
        strategy: "update-ca-certificates",
        detail: "Skipped automatic CA trust installation because Linux system trust updates typically require root privileges.",
        attempted: false,
        requiresUserAction: true,
      });
    } else {
      try {
        await copyFile(caCertFile, securityPaths.linuxSystemCaFile);
        await runCommand(
          "update-ca-certificates",
          [],
          { timeoutMs: TRUST_INSTALL_COMMAND_TIMEOUT_MS },
        );
        trustStatus = buildTrustStatus({
          state: "installed",
          strategy: "update-ca-certificates",
          detail: `Installed the generated CA into ${securityPaths.linuxSystemCaFile} and refreshed the system CA bundle.`,
          attempted: true,
          requiresUserAction: false,
        });
      } catch (error) {
        const detail = error.stderr || error.message;
        const skipped = /not found|ENOENT|No such file/i.test(detail);
        trustStatus = buildTrustStatus({
          state: skipped ? "skipped" : "failed",
          strategy: "update-ca-certificates",
          detail,
          attempted: true,
          requiresUserAction: skipped,
        });
      }
    }
  } else {
    trustStatus = buildTrustStatus({
      state: "skipped",
      strategy: null,
      detail: `Automatic CA trust installation is not implemented for ${process.platform}.`,
      attempted: false,
      requiresUserAction: true,
    });
  }

  if (trustStatus.state === "installed") {
    await writeTrustState(securityPaths.trustStateFile, {
      ...trustStatus,
      fingerprint: certificateFingerprint,
      installedAt: new Date().toISOString(),
    });
  }

  return trustStatus;
}

async function ensureTlsFiles(options, runtimePaths, advertisedHostname, lanBindAddress) {
  if (!isWebSocketTlsEnabled(options)) {
    if (options.tls?.certFile || options.tls?.keyFile) {
      throw new Error("options.tls.certFile/keyFile cannot be used when options.webSocketTls is false");
    }

    return {
      certFile: null,
      keyFile: null,
      generated: false,
      caCertFile: null,
      trustStatus: buildTrustStatus({
        state: "skipped",
        strategy: "no-tls",
        detail: "Local WebSocket TLS is disabled via options.webSocketTls=false.",
        attempted: false,
        requiresUserAction: false,
      }),
      mode: "disabled",
    };
  }

  if (options.tls?.certFile || options.tls?.keyFile) {
    if (!options.tls?.certFile || !options.tls?.keyFile) {
      throw new Error("options.tls.certFile and options.tls.keyFile must be provided together");
    }

    await access(options.tls.certFile);
    await access(options.tls.keyFile);
    return {
      certFile: path.resolve(options.tls.certFile),
      keyFile: path.resolve(options.tls.keyFile),
      generated: false,
      caCertFile: null,
      trustStatus: buildTrustStatus({
        state: "external",
        strategy: null,
        detail: "Using caller-provided TLS certificate and key files.",
        attempted: false,
        requiresUserAction: false,
      }),
      mode: "external",
    };
  }

  const securityPaths = createLeafSecurityPaths(options.cacheDir);
  const generatedCa = await ensureGeneratedLeafCertificateAuthority(securityPaths);
  const openSslConfig = path.join(runtimePaths.certsDir, "openssl.cnf");
  const csrFile = path.join(runtimePaths.certsDir, "leaf.csr");
  const altNames = buildLeafTlsAltNames(advertisedHostname, lanBindAddress);
  const configContents = buildLeafOpenSslConfig({
    commonName: advertisedHostname,
    altNames,
  });
  await writeFile(openSslConfig, configContents, "utf8");

  try {
    await runCommand("openssl", [
      "req",
      "-nodes",
      "-newkey",
      "rsa:2048",
      "-keyout",
      runtimePaths.keyFile,
      "-out",
      csrFile,
      "-config",
      openSslConfig,
      "-reqexts",
      "v3_req",
    ]);
    await runCommand("openssl", [
      "x509",
      "-req",
      "-in",
      csrFile,
      "-CA",
      generatedCa.caCertFile,
      "-CAkey",
      generatedCa.caKeyFile,
      "-CAcreateserial",
      "-out",
      runtimePaths.certFile,
      "-days",
      String(GENERATED_LEAF_CERT_VALIDITY_DAYS),
      "-sha256",
      "-extfile",
      openSslConfig,
      "-extensions",
      "v3_req",
    ]);
  } catch (error) {
    throw new Error(
      `Unable to auto-generate TLS files for the local leaf runtime. ` +
      `Provide options.tls.certFile/keyFile or ensure "openssl" is available in PATH. ` +
      `Original error: ${error.stderr || error.message}`,
    );
  }

  const trustStatus = await maybeInstallGeneratedCaTrust(securityPaths, generatedCa.caCertFile);

  return {
    certFile: runtimePaths.certFile,
    keyFile: runtimePaths.keyFile,
    generated: true,
    caCertFile: generatedCa.caCertFile,
    trustStatus,
    mode: "generated-ca",
  };
}

function createRuntimePaths(baseRuntimeDir) {
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

async function createRuntimeDirectory(parentDir) {
  const baseDir = parentDir ? path.resolve(parentDir) : os.tmpdir();
  await mkdir(baseDir, { recursive: true });
  return await mkdtemp(path.join(baseDir, "kinopio-leaf-"));
}

async function ensureRuntimeFolders(runtimePaths) {
  await mkdir(runtimePaths.certsDir, { recursive: true });
  await mkdir(runtimePaths.storeDir, { recursive: true });
  await mkdir(runtimePaths.runDir, { recursive: true });
  await mkdir(runtimePaths.logsDir, { recursive: true });
}

async function probeMonitorHealth(monitorUrl) {
  const healthUrl = new URL("/healthz", monitorUrl);
  await new Promise((resolve, reject) => {
    const request = http.get(healthUrl, (response) => {
      const chunks = [];
      response.setEncoding("utf8");
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode === 200) {
          resolve();
          return;
        }
        reject(new Error(`Monitoring health probe returned ${response.statusCode}: ${chunks.join("")}`));
      });
    });
    request.on("error", reject);
  });
}

async function probeNatsClient(clientPort) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: "127.0.0.1",
      port: clientPort,
    });
    let buffer = "";
    let pingSent = false;
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for the local NATS client listener"));
    }, 2_000);

    socket.setEncoding("utf8");
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!pingSent && buffer.includes("INFO")) {
        socket.write('CONNECT {"verbose":false,"pedantic":false}\r\nPING\r\n');
        pingSent = true;
      }
      if (pingSent && buffer.includes("PONG")) {
        clearTimeout(timeout);
        socket.end();
        resolve();
      }
    });
  });
}

async function probeTlsListener(host, port) {
  await new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      rejectUnauthorized: false,
      servername: isIpv4Address(host) ? undefined : host,
    });

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for the local WSS listener"));
    }, 2_000);

    socket.on("secureConnect", () => {
      clearTimeout(timeout);
      socket.end();
      resolve();
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function probeTcpListener(host, port) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for the local WS listener"));
    }, 2_000);

    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.end();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function probeDiscoveryEndpoint(discoveryUrl) {
  await new Promise((resolve, reject) => {
    const url = new URL(discoveryUrl);
    const requestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
    };
    const client = url.protocol === "https:" ? https : http;
    if (url.protocol === "https:") {
      requestOptions.rejectUnauthorized = false;
      requestOptions.servername = isIpv4Address(url.hostname) ? undefined : url.hostname;
    }

    const request = client.get(
      requestOptions,
      (response) => {
        const chunks = [];
        response.setEncoding("utf8");
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error(`Discovery probe returned ${response.statusCode}: ${chunks.join("")}`));
            return;
          }

          try {
            JSON.parse(chunks.join(""));
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
  });
}

async function fetchJson(url) {
  return await new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const request = http.get(parsedUrl, (response) => {
      const chunks = [];
      response.setEncoding("utf8");
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} from ${url}`));
          return;
        }

        try {
          resolve(JSON.parse(chunks.join("")));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
  });
}

function createPeerRecordFromPayload(payload, receivedAt = Date.now()) {
  if (!isPlainObject(payload)) return null;
  if (typeof payload.nodeId !== "string" || payload.nodeId.trim() === "") return null;
  if (typeof payload.discoveryNamespace !== "string" || payload.discoveryNamespace.trim() === "") return null;

  return {
    version: typeof payload.version === "string" ? payload.version : "1",
    expiresAt:
      typeof payload.expiresAt === "string"
        ? payload.expiresAt
        : typeof payload.leaseExpiresAt === "string"
          ? payload.leaseExpiresAt
          : new Date(receivedAt + DEFAULT_DISCOVERY_MANIFEST_TTL_MS).toISOString(),
    leaderEpoch: normalizeEpoch(payload.leaderEpoch),
    advertisedHostname: typeof payload.advertisedHostname === "string" ? payload.advertisedHostname : "",
    websocketUrl:
      typeof payload.websocketUrl === "string"
        ? payload.websocketUrl
        : typeof payload.wssUrl === "string"
          ? payload.wssUrl
          : "",
    wssUrl:
      typeof payload.wssUrl === "string"
        ? payload.wssUrl
        : typeof payload.websocketUrl === "string"
          ? payload.websocketUrl
          : "",
    discoveryUrl: typeof payload.discoveryUrl === "string" ? payload.discoveryUrl : "",
    fallbackServers: normalizeStringArray(payload.fallbackServers),
    backboneRttMs: normalizeFiniteRtt(payload.backboneRttMs),
    leaseExpiresAt: typeof payload.leaseExpiresAt === "string" ? payload.leaseExpiresAt : undefined,
    nodeId: payload.nodeId,
    discoveryNamespace: payload.discoveryNamespace,
    isLeader: Boolean(payload.isLeader),
    candidateRole:
      payload.candidateRole === "leader" ||
      payload.candidateRole === "follower" ||
      payload.candidateRole === "candidate" ||
      payload.candidateRole === "stopped"
        ? payload.candidateRole
        : payload.isLeader
          ? "leader"
          : "candidate",
    receivedAt,
  };
}

function createPeerRecordFromManifest(manifest, receivedAt = Date.now()) {
  return createPeerRecordFromPayload(
    {
      ...manifest,
      isLeader: manifest?.isLeader ?? true,
      candidateRole: manifest?.candidateRole || "leader",
    },
    receivedAt,
  );
}

function mergePeerRecords(existing, next) {
  if (!existing) return next;
  if (!next) return existing;

  const preferred = (next.receivedAt || 0) >= (existing.receivedAt || 0) ? next : existing;
  const fallback = preferred === next ? existing : next;
  const preferredFallbackServers = normalizeStringArray(preferred.fallbackServers);
  const fallbackFallbackServers = normalizeStringArray(fallback.fallbackServers);

  return {
    version: preferred.version || fallback.version || "1",
    expiresAt: preferred.expiresAt || fallback.expiresAt || "",
    leaderEpoch: Math.max(normalizeEpoch(existing.leaderEpoch), normalizeEpoch(next.leaderEpoch)),
    advertisedHostname: preferred.advertisedHostname || fallback.advertisedHostname || "",
    websocketUrl: preferred.websocketUrl || fallback.websocketUrl || preferred.wssUrl || fallback.wssUrl || "",
    wssUrl: preferred.wssUrl || fallback.wssUrl || preferred.websocketUrl || fallback.websocketUrl || "",
    discoveryUrl: preferred.discoveryUrl || fallback.discoveryUrl || "",
    fallbackServers: preferredFallbackServers.length > 0 ? preferredFallbackServers : fallbackFallbackServers,
    backboneRttMs:
      normalizeFiniteRtt(preferred.backboneRttMs) ??
      normalizeFiniteRtt(fallback.backboneRttMs),
    leaseExpiresAt: preferred.leaseExpiresAt || fallback.leaseExpiresAt,
    nodeId: preferred.nodeId || fallback.nodeId,
    discoveryNamespace: preferred.discoveryNamespace || fallback.discoveryNamespace,
    isLeader: Boolean(preferred.isLeader || fallback.isLeader),
    candidateRole: preferred.candidateRole || fallback.candidateRole || "candidate",
    receivedAt: Math.max(existing.receivedAt || 0, next.receivedAt || 0),
  };
}

function toPublicManifest(record) {
  if (!record) {
    return null;
  }

  return cloneManifest({
    version: record.version || "1",
    expiresAt: record.expiresAt || record.leaseExpiresAt || new Date(Date.now() + DEFAULT_DISCOVERY_MANIFEST_TTL_MS).toISOString(),
    leaderEpoch: normalizeEpoch(record.leaderEpoch),
    advertisedHostname: record.advertisedHostname || "",
    websocketUrl: record.websocketUrl || record.wssUrl || "",
    wssUrl: record.wssUrl || record.websocketUrl || "",
    discoveryUrl: record.discoveryUrl || undefined,
    fallbackServers: normalizeStringArray(record.fallbackServers),
    backboneRttMs: normalizeFiniteRtt(record.backboneRttMs),
    leaseExpiresAt: record.leaseExpiresAt || undefined,
    nodeId: record.nodeId || undefined,
    discoveryNamespace: record.discoveryNamespace || undefined,
    isLeader: Boolean(record.isLeader),
    candidateRole: record.candidateRole || (record.isLeader ? "leader" : "candidate"),
  });
}

function rememberPeerRecord(store, record) {
  if (!record?.nodeId) return;
  const existing = store.get(record.nodeId);
  store.set(record.nodeId, mergePeerRecords(existing, record));
}

function isRecordFresh(record, now = Date.now()) {
  if (!record) return false;
  if ((now - (record.receivedAt || 0)) > AUTO_COORDINATION_STALE_MS) {
    return false;
  }

  if (record.isLeader && record.leaseExpiresAt) {
    return isLeaseActive(record.leaseExpiresAt, now);
  }

  return true;
}

function pruneRecordStore(store, now = Date.now()) {
  for (const [nodeId, record] of store.entries()) {
    if (!isRecordFresh(record, now)) {
      store.delete(nodeId);
    }
  }
}

function buildSelfPresenceRecord(agent, now = Date.now(), candidateRole = mapAutoLeafRole(agent.stateName)) {
  const localLeaderRecord = createLocalLeaderRecord(agent, now);
  if (localLeaderRecord && candidateRole === "leader") {
    return localLeaderRecord;
  }

  return {
    version: "1",
    expiresAt: new Date(now + DEFAULT_DISCOVERY_MANIFEST_TTL_MS).toISOString(),
    leaderEpoch: normalizeEpoch(agent.localLeaderEpoch),
    advertisedHostname: agent.advertisedHostname,
    websocketUrl: localLeaderRecord?.websocketUrl || localLeaderRecord?.wssUrl || "",
    wssUrl: localLeaderRecord?.wssUrl || localLeaderRecord?.websocketUrl || "",
    discoveryUrl: localLeaderRecord?.discoveryUrl || "",
    fallbackServers: [...agent.normalizedBackboneServers],
    backboneRttMs: normalizeFiniteRtt(agent.backboneRttMs),
    leaseExpiresAt: localLeaderRecord?.leaseExpiresAt,
    nodeId: agent.nodeId,
    discoveryNamespace: agent.discoveryNamespace,
    isLeader: candidateRole === "leader",
    candidateRole,
    receivedAt: now,
  };
}

function collectLeaderRecords(agent, now = Date.now()) {
  const merged = new Map();
  const localLeaderRecord = createLocalLeaderRecord(agent, now);

  if (localLeaderRecord) {
    rememberPeerRecord(merged, localLeaderRecord);
  }

  for (const record of agent.peerRecords.values()) {
    if (record.isLeader && isRecordFresh(record, now)) {
      rememberPeerRecord(merged, record);
    }
  }

  for (const record of agent.mdnsRecords.values()) {
    if (record.isLeader && isRecordFresh(record, now)) {
      rememberPeerRecord(merged, record);
    }
  }

  return [...merged.values()];
}

function collectElectionCandidates(agent, now = Date.now(), includeSelfAsCandidate = false) {
  const candidates = [];
  const selfRole = includeSelfAsCandidate ? "candidate" : mapAutoLeafRole(agent.stateName);
  if (selfRole === "candidate" || selfRole === "leader") {
    candidates.push(buildSelfPresenceRecord(agent, now, selfRole));
  }

  for (const record of agent.peerRecords.values()) {
    if (!isRecordFresh(record, now)) continue;
    if (record.candidateRole === "candidate" || record.isLeader) {
      candidates.push(record);
    }
  }

  return candidates;
}

function readPortFromUrl(url) {
  if (typeof url !== "string" || url.trim() === "") {
    return null;
  }

  const parsed = new URL(url);
  const fallbackPort =
    parsed.protocol === "https:" ? 443
    : parsed.protocol === "wss:" ? 443
    : parsed.protocol === "http:" ? 80
    : parsed.protocol === "ws:" ? 80
    : null;

  return parsed.port ? Number(parsed.port) : fallbackPort;
}

function readProtocolNameFromUrl(url, fallback = "") {
  if (typeof url !== "string" || url.trim() === "") {
    return fallback;
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol.replace(/:$/u, "") || fallback;
  } catch {
    return fallback;
  }
}

function noteObservedEpoch(agent, record) {
  agent.maxObservedLeaderEpoch = Math.max(agent.maxObservedLeaderEpoch, normalizeEpoch(record?.leaderEpoch));
}

function createLocalLeaderRecord(agent, now = Date.now()) {
  if (!agent.localLeaf) {
    return null;
  }

  const localStatus = agent.localLeaf.status();
  if (localStatus.phase !== "ready") {
    return null;
  }

  return createPeerRecordFromPayload(
    {
      ...localStatus.manifest,
      nodeId: agent.nodeId,
      discoveryNamespace: agent.discoveryNamespace,
      leaderEpoch: normalizeEpoch(agent.localLeaderEpoch),
      leaseExpiresAt: agent.localLeaseExpiresAt || localStatus.manifest.leaseExpiresAt || makeLeaseExpiresAt(now, DEFAULT_LEADER_LEASE_MS),
      backboneRttMs: normalizeFiniteRtt(agent.backboneRttMs),
      fallbackServers: [...agent.normalizedBackboneServers],
      isLeader: true,
      candidateRole: "leader",
    },
    now,
  );
}

function updateCurrentLeader(agent, leaderRecord) {
  if (!leaderRecord) {
    agent.currentLeaderRecord = null;
    agent.currentLeaderManifest = null;
    return;
  }

  agent.currentLeaderRecord =
    agent.currentLeaderRecord?.nodeId === leaderRecord.nodeId
      ? mergePeerRecords(agent.currentLeaderRecord, leaderRecord)
      : leaderRecord;
  agent.currentLeaderManifest = toPublicManifest(agent.currentLeaderRecord);
}

function syncLocalLeafManifest(agent, now = Date.now()) {
  if (!agent.localLeaf) {
    return null;
  }

  agent.localLeaseExpiresAt = makeLeaseExpiresAt(now, DEFAULT_LEADER_LEASE_MS);
  agent.localLeaf.__setManifestState?.({
    nodeId: agent.nodeId,
    discoveryNamespace: agent.discoveryNamespace,
    leaderEpoch: normalizeEpoch(agent.localLeaderEpoch),
    leaseExpiresAt: agent.localLeaseExpiresAt,
    backboneRttMs: normalizeFiniteRtt(agent.backboneRttMs),
    isLeader: true,
    candidateRole: "leader",
  });

  const record = createLocalLeaderRecord(agent, now);
  if (record) {
    noteObservedEpoch(agent, record);
    updateCurrentLeader(agent, record);
  }
  return record;
}

function buildCoordinationPayload(agent, now = Date.now()) {
  const role = mapAutoLeafRole(agent.stateName);
  const presence = buildSelfPresenceRecord(agent, now, role);

  return {
    kind: "kinopio-auto-leaf-heartbeat",
    protocolVersion: AUTO_PROTOCOL_VERSION,
    sentAt: new Date(now).toISOString(),
    ...presence,
  };
}

async function broadcastCoordinationHeartbeat(agent) {
  if (agent.stopped) return;

  try {
    if (agent.localLeaf && agent.stateName === "leader") {
      syncLocalLeafManifest(agent);
    }

    await agent.coordinationBus.send(
      Buffer.from(JSON.stringify(buildCoordinationPayload(agent)), "utf8"),
    );
  } catch (error) {
    agent.lastError = toErrorMessage(error);
  }
}

async function broadcastMdnsAnnouncement(agent) {
  if (agent.stopped || !agent.mdnsBus.available || !agent.localLeaf || agent.stateName !== "leader") {
    return;
  }

  const leaderRecord = syncLocalLeafManifest(agent);
  if (!leaderRecord) {
    return;
  }

  try {
    const packet = buildMdnsAnnouncementPacket({
      discoveryNamespace: agent.discoveryNamespace,
      nodeId: agent.nodeId,
      advertisedHostname: leaderRecord.advertisedHostname,
      advertisedAddress: agent.lanBindAddress,
      discoveryPort: readPortFromUrl(leaderRecord.discoveryUrl),
      websocketPort: readPortFromUrl(leaderRecord.websocketUrl || leaderRecord.wssUrl),
      websocketProtocol: readProtocolNameFromUrl(leaderRecord.websocketUrl || leaderRecord.wssUrl, "wss"),
      discoveryProtocol: readProtocolNameFromUrl(leaderRecord.discoveryUrl, "https"),
      leaderEpoch: normalizeEpoch(leaderRecord.leaderEpoch),
      leaseExpiresAt: leaderRecord.leaseExpiresAt || makeLeaseExpiresAt(),
      backboneRttMs: normalizeFiniteRtt(leaderRecord.backboneRttMs),
      ttlSeconds: AUTO_MDNS_TTL_SECONDS,
    });
    await agent.mdnsBus.send(packet);
  } catch (error) {
    agent.lastError = toErrorMessage(error);
  }
}

async function queryMdns(agent) {
  if (agent.stopped || !agent.mdnsBus.available) {
    return;
  }

  try {
    await agent.mdnsBus.send(buildMdnsQueryPacket());
  } catch (error) {
    agent.lastError = toErrorMessage(error);
  }
}

async function refreshAutoLeafBackboneRtt(agent) {
  if (agent.stopped || agent.backboneProbePromise) {
    return await agent.backboneProbePromise;
  }

  agent.backboneProbePromise = (async () => {
    agent.backboneRttMs = await measureBackboneRtt(agent.normalizedBackboneServers);
    agent.lastBackboneProbeError = null;
    if (agent.localLeaf && agent.stateName === "leader") {
      syncLocalLeafManifest(agent);
    }
  })()
    .catch((error) => {
      agent.backboneRttMs = null;
      agent.lastBackboneProbeError = toErrorMessage(error);
    })
    .finally(() => {
      agent.backboneProbePromise = null;
    });

  return await agent.backboneProbePromise;
}

function transitionToFollowingLeader(agent, leaderRecord) {
  agent.stateName = "following-leader";
  agent.missingLeaderSince = null;
  agent.preemptionStreak = 0;
  updateCurrentLeader(agent, leaderRecord);
}

function transitionToLeaderMissingGrace(agent, now = Date.now()) {
  agent.stateName = "leader-missing-grace";
  agent.missingLeaderSince = agent.missingLeaderSince ?? now;
  agent.preemptionStreak = 0;
}

async function stopLocalLeaf(agent) {
  const leaf = agent.localLeaf;
  agent.localLeaf = null;
  agent.localLeaseExpiresAt = null;
  if (!leaf) {
    return;
  }

  try {
    await leaf.stop();
  } catch (error) {
    agent.lastError = toErrorMessage(error);
  }
}

async function stepDownToLeader(agent, leaderRecord, now = Date.now()) {
  await stopLocalLeaf(agent);
  if (leaderRecord) {
    transitionToFollowingLeader(agent, leaderRecord);
    return;
  }

  updateCurrentLeader(agent, null);
  transitionToLeaderMissingGrace(agent, now);
}

async function startAutoLeafLeader(agent) {
  if (agent.stopped || agent.localLeaf || agent.leafStartPromise) {
    return await agent.leafStartPromise;
  }

  agent.stateName = "starting-leaf";
  agent.localLeaderEpoch = Math.max(
    normalizeEpoch(agent.localLeaderEpoch),
    normalizeEpoch(agent.currentLeaderRecord?.leaderEpoch),
    normalizeEpoch(agent.maxObservedLeaderEpoch),
  ) + 1;

  agent.leafStartPromise = (async () => {
    const leaf = await startLeafNode({
      ...agent.options,
      nodeId: agent.nodeId,
    });

    if (agent.stopped) {
      await leaf.stop();
      return null;
    }

    agent.localLeaf = leaf;
    agent.lastLeafStartFailureAt = 0;
    agent.lastError = null;
    agent.stateName = "leader";
    syncLocalLeafManifest(agent);
    await broadcastCoordinationHeartbeat(agent);
    await broadcastMdnsAnnouncement(agent);
    return leaf;
  })()
    .catch(async (error) => {
      agent.lastError = toErrorMessage(error);
      agent.lastLeafStartFailureAt = Date.now();
      agent.stateName = "electing";
      if (agent.localLeaf) {
        await stopLocalLeaf(agent);
      }
      return null;
    })
    .finally(() => {
      agent.leafStartPromise = null;
    });

  return await agent.leafStartPromise;
}

function createAutoLeafStatusSnapshot(agent) {
  return Object.freeze({
    state: agent.stateName,
    role: mapAutoLeafRole(agent.stateName),
    leader: agent.currentLeaderManifest,
    nodeId: agent.nodeId,
    backboneRttMs: normalizeFiniteRtt(agent.backboneRttMs),
    leaderEpoch: normalizeEpoch(agent.localLeaderEpoch),
    leaderMissingGraceMs: agent.leaderMissingGraceMs,
    preemptionStreak: agent.preemptionStreak,
    lastError: agent.lastError,
    localLeaf: agent.localLeaf ? agent.localLeaf.status() : null,
    mdnsAvailable: agent.mdnsBus.available,
  });
}

async function evaluateAutoLeafAgent(agent) {
  if (agent.stopped || agent.evaluationPromise) {
    return await agent.evaluationPromise;
  }

  agent.evaluationPromise = (async () => {
    const now = Date.now();
    pruneRecordStore(agent.peerRecords, now);
    pruneRecordStore(agent.mdnsRecords, now);

    if (agent.localLeaf && agent.localLeaf.status().phase !== "ready") {
      await stepDownToLeader(agent, null, now);
    }

    const leaders = collectLeaderRecords(agent, now);
    for (const record of leaders) {
      noteObservedEpoch(agent, record);
    }

    const bestLeader = chooseBestLeader(leaders);
    if (bestLeader) {
      updateCurrentLeader(agent, bestLeader);
    } else if (agent.stateName !== "leader") {
      updateCurrentLeader(agent, null);
    }

    const localLeaderRecord = createLocalLeaderRecord(agent, now);
    if (
      localLeaderRecord &&
      bestLeader &&
      bestLeader.nodeId !== agent.nodeId &&
      compareLeaderRecords(bestLeader, localLeaderRecord) < 0
    ) {
      await stepDownToLeader(agent, bestLeader, now);
      return;
    }

    switch (agent.stateName) {
      case "discovering": {
        if (bestLeader && bestLeader.nodeId !== agent.nodeId) {
          transitionToFollowingLeader(agent, bestLeader);
          return;
        }

        if (now >= agent.discoverySettledAt) {
          agent.stateName = "electing";
        }
        return;
      }

      case "following-leader": {
        if (!bestLeader || bestLeader.nodeId === agent.nodeId) {
          transitionToLeaderMissingGrace(agent, now);
          return;
        }

        transitionToFollowingLeader(agent, bestLeader);
        const electionWinner = chooseElectionWinner(
          collectElectionCandidates(agent, now, true),
        );

        if (
          electionWinner?.nodeId === agent.nodeId &&
          shouldAttemptPreemption(agent.backboneRttMs, bestLeader.backboneRttMs)
        ) {
          agent.preemptionStreak += 1;
          if (agent.preemptionStreak >= PREEMPTION_CONFIRMATION_CYCLES) {
            agent.stateName = "electing";
          }
        } else {
          agent.preemptionStreak = 0;
        }
        return;
      }

      case "leader-missing-grace": {
        if (bestLeader && bestLeader.nodeId !== agent.nodeId) {
          transitionToFollowingLeader(agent, bestLeader);
          return;
        }

        if (agent.missingLeaderSince !== null && (now - agent.missingLeaderSince) >= agent.leaderMissingGraceMs) {
          agent.stateName = "electing";
        }
        return;
      }

      case "electing": {
        if (bestLeader && bestLeader.nodeId !== agent.nodeId) {
          transitionToFollowingLeader(agent, bestLeader);
          return;
        }

        if (agent.lastLeafStartFailureAt && (now - agent.lastLeafStartFailureAt) < AUTO_LEAF_RETRY_DELAY_MS) {
          return;
        }

        const electionWinner = chooseElectionWinner(collectElectionCandidates(agent, now, true));
        if (electionWinner?.nodeId === agent.nodeId) {
          await startAutoLeafLeader(agent);
        }
        return;
      }

      case "starting-leaf":
        return;

      case "leader":
        syncLocalLeafManifest(agent, now);
        updateCurrentLeader(agent, createLocalLeaderRecord(agent, now));
        return;

      default:
        return;
    }
  })().finally(() => {
    agent.evaluationPromise = null;
  });

  return await agent.evaluationPromise;
}

function createDiscoveryManifest(state) {
  const manifestBackboneRttMs =
    Object.prototype.hasOwnProperty.call(state.manifestState, "backboneRttMs")
      ? normalizeFiniteRtt(state.manifestState.backboneRttMs)
      : state.backboneRttMs;
  const leaseExpiresAt =
    typeof state.manifestState.leaseExpiresAt === "string"
      ? state.manifestState.leaseExpiresAt
      : undefined;

  return {
    version: "1",
    expiresAt: leaseExpiresAt || new Date(Date.now() + DEFAULT_DISCOVERY_MANIFEST_TTL_MS).toISOString(),
    leaderEpoch: normalizeEpoch(state.manifestState.leaderEpoch),
    advertisedHostname: state.advertisedHostname,
    websocketUrl: state.websocketUrl,
    wssUrl: state.wssUrl,
    discoveryUrl: state.discoveryUrl,
    fallbackServers: [...state.backboneServers],
    backboneRttMs: manifestBackboneRttMs,
    leaseExpiresAt,
    nodeId: state.manifestState.nodeId || undefined,
    discoveryNamespace: state.manifestState.discoveryNamespace || state.discoveryNamespace,
    isLeader: state.manifestState.isLeader ?? true,
    candidateRole: state.manifestState.candidateRole || "leader",
  };
}

function snapshotState(state) {
  return Object.freeze({
    phase: state.phase,
    bridgeState: state.bridgeState,
    websocketUrl: state.websocketUrl,
    wssUrl: state.wssUrl,
    discoveryUrl: state.discoveryUrl,
    clientUrl: state.clientUrl,
    monitorUrl: state.monitorUrl,
    runtimeVersion: NATS_SERVER_VERSION,
    binaryPath: state.binaryPath,
    runtimeDir: state.runtimeDir,
    lanBindAddress: state.lanBindAddress,
    ports: { ...state.ports },
    configFile: state.configFile,
    logFile: state.logFile,
    pidFile: state.pidFile,
    storeDir: state.storeDir,
    processId: state.processId,
    processExitCode: state.processExitCode,
    lastError: state.lastError,
    outputTail: [...state.outputTail],
    manifest: createDiscoveryManifest(state),
    tls: {
      mode: state.tls.mode,
      certFile: state.tls.certFile,
      caCertFile: state.tls.caCertFile,
      trust: { ...state.tls.trust },
    },
  });
}

function pushOutputLine(state, prefix, content) {
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    state.outputTail.push(`${prefix}${line}`);
  }
  if (state.outputTail.length > 50) {
    state.outputTail.splice(0, state.outputTail.length - 50);
  }
}

async function startDiscoveryServer(state, tlsMaterial) {
  const serverFactory = state.webSocketTls ? https.createServer : http.createServer;
  const serverOptions = state.webSocketTls
    ? {
        cert: await readFile(tlsMaterial.certFile),
        key: await readFile(tlsMaterial.keyFile),
      }
    : undefined;

  state.discoveryServer = serverFactory(
    serverOptions,
    (request, response) => {
      const requestPath = new URL(request.url || "/", state.discoveryUrl).pathname;
      if (requestPath !== WELL_KNOWN_MANIFEST_PATH) {
        response.statusCode = 404;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }

      response.statusCode = 200;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify(createDiscoveryManifest(state)));
    },
  );

  await new Promise((resolve, reject) => {
    state.discoveryServer.once("error", reject);
    state.discoveryServer.listen(state.ports.discovery, state.lanBindAddress, () => {
      state.discoveryServer.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server) {
  await new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }

    server.close(() => resolve());
  });
}

async function refreshBridgeState(state) {
  if (state.backboneServers.length === 0) {
    state.bridgeState = "disconnected";
    state.backboneRttMs = null;
    return;
  }

  try {
    const varz = await fetchJson(new URL("/varz", state.monitorUrl));
    const leafConnectionCount = typeof varz.leafnodes === "number" ? varz.leafnodes : 0;
    state.bridgeState = leafConnectionCount > 0 ? "connected" : "connecting";
    state.lastBridgeError = null;
  } catch (error) {
    state.bridgeState = "connecting";
    state.lastBridgeError = error instanceof Error ? error.message : String(error);
  }
}

async function waitForLeafRuntimeReady(state, startupErrorRef) {
  const startedAt = Date.now();
  let lastProbeError = null;

  while (Date.now() - startedAt < DEFAULT_LEAF_READY_TIMEOUT_MS) {
    if (startupErrorRef.current) {
      throw startupErrorRef.current;
    }

    try {
      await Promise.all([
        probeMonitorHealth(state.monitorUrl),
        probeNatsClient(state.ports.client),
        state.webSocketTls
          ? probeTlsListener(state.lanBindAddress, state.ports.websocket)
          : probeTcpListener(state.lanBindAddress, state.ports.websocket),
        probeDiscoveryEndpoint(state.discoveryUrl),
      ]);
      await refreshBridgeState(state);
      return;
    } catch (error) {
      lastProbeError = error;
      await sleep(250);
    }
  }

  throw new Error(
    `Timed out waiting for the local leaf runtime to become ready${lastProbeError ? `: ${lastProbeError.message}` : ""}`,
  );
}

async function terminateChildProcess(childProcess) {
  if (!childProcess || childProcess.exitCode !== null || childProcess.killed) {
    return;
  }

  const exitPromise = new Promise((resolve) => {
    childProcess.once("exit", () => resolve());
  });

  childProcess.kill("SIGTERM");
  const timeoutPromise = sleep(5_000).then(() => "timeout");
  const result = await Promise.race([exitPromise, timeoutPromise]);
  if (result === "timeout") {
    childProcess.kill("SIGKILL");
    await exitPromise;
  }
}

export async function startLeafNode(options) {
  assertNodeRuntime("startLeafNode()");
  validateLeafNodeOptions(options);

  const normalizedBackboneServers = (options.backboneServers || []).map(normalizeBackboneServerUrl);
  assertCompatibleBackboneServers(normalizedBackboneServers);
  const webSocketTls = isWebSocketTlsEnabled(options);
  const lanBindAddress = chooseLanAddress(options.lanBindAddress);
  const advertisedHostname = options.advertisedHostname || lanBindAddress;
  const { binaryPath } = await ensureNatsServerBinary({
    cacheDir: options.cacheDir,
    binaryPath: options.binaryPath,
  });
  const runtimeDir = await createRuntimeDirectory(options.runtimeDir);
  const runtimePaths = createRuntimePaths(runtimeDir);

  await ensureRuntimeFolders(runtimePaths);

  const ports = await resolveLeafPorts(options.ports, lanBindAddress);
  const tlsMaterial = await ensureTlsFiles(options, runtimePaths, advertisedHostname, lanBindAddress);
  const configContents = renderLeafConfig({
    paths: {
      ...runtimePaths,
      certFile: tlsMaterial.certFile,
      keyFile: tlsMaterial.keyFile,
    },
    ports,
    lanBindAddress,
    advertisedHostname,
    normalizedBackboneServers,
    webSocketTls,
  });
  await writeFile(runtimePaths.configFile, configContents, "utf8");

  const state = {
    phase: "starting",
    bridgeState: normalizedBackboneServers.length > 0 ? "connecting" : "disconnected",
    backboneServers: normalizedBackboneServers,
    backboneRttMs: null,
    discoveryNamespace: options.discoveryNamespace,
    advertisedHostname,
    lanBindAddress,
    binaryPath,
    runtimeDir,
    configFile: runtimePaths.configFile,
    logFile: runtimePaths.logFile,
    pidFile: runtimePaths.pidFile,
    storeDir: runtimePaths.storeDir,
    ports,
    webSocketTls,
    websocketUrl: `${webSocketTls ? "wss" : "ws"}://${advertisedHostname}:${ports.websocket}`,
    clientUrl: `nats://127.0.0.1:${ports.client}`,
    monitorUrl: `http://127.0.0.1:${ports.monitor}`,
    wssUrl: `${webSocketTls ? "wss" : "ws"}://${advertisedHostname}:${ports.websocket}`,
    discoveryUrl: `${webSocketTls ? "https" : "http"}://${advertisedHostname}:${ports.discovery}${WELL_KNOWN_MANIFEST_PATH}`,
    processId: null,
    processExitCode: null,
    lastError: null,
    lastBridgeError: null,
    outputTail: [],
    tls: {
      mode: tlsMaterial.mode,
      certFile: tlsMaterial.certFile,
      caCertFile: tlsMaterial.caCertFile,
      trust: { ...tlsMaterial.trustStatus },
    },
    discoveryServer: null,
    backgroundPollTimer: null,
    stopPromise: null,
    childProcess: null,
    manifestState: {
      leaderEpoch: 0,
      leaseExpiresAt: undefined,
      backboneRttMs: null,
      nodeId: options.nodeId || undefined,
      discoveryNamespace: options.discoveryNamespace,
      isLeader: true,
      candidateRole: "leader",
    },
  };

  const startupErrorRef = { current: null };

  try {
    await startDiscoveryServer(state, tlsMaterial);

    const childProcess = spawn(binaryPath, ["-c", runtimePaths.configFile], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    state.childProcess = childProcess;
    state.processId = childProcess.pid ?? null;

    childProcess.stdout?.setEncoding("utf8");
    childProcess.stderr?.setEncoding("utf8");
    childProcess.stdout?.on("data", (chunk) => {
      pushOutputLine(state, "[stdout] ", chunk);
    });
    childProcess.stderr?.on("data", (chunk) => {
      pushOutputLine(state, "[stderr] ", chunk);
    });
    childProcess.on("error", (error) => {
      state.phase = "error";
      state.lastError = error.message;
      startupErrorRef.current = error;
    });
    childProcess.on("exit", (code, signal) => {
      state.processExitCode = code;
      if (state.phase !== "stopping" && state.phase !== "stopped") {
        state.phase = "error";
        state.lastError = `nats-server exited before shutdown with code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}`;
        startupErrorRef.current = new Error(state.lastError);
      }
    });

    await waitForLeafRuntimeReady(state, startupErrorRef);

    state.phase = "ready";
    state.backgroundPollTimer = setInterval(() => {
      refreshBridgeState(state).catch((error) => {
        state.lastBridgeError = error instanceof Error ? error.message : String(error);
      });
    }, DEFAULT_BRIDGE_POLL_INTERVAL_MS);
    state.backgroundPollTimer.unref?.();

    return {
      websocketUrl: state.websocketUrl,
      wssUrl: state.wssUrl,
      discoveryUrl: state.discoveryUrl,
      advertisedHostname: state.advertisedHostname,
      clientUrl: state.clientUrl,
      monitorUrl: state.monitorUrl,
      __setManifestState(patch) {
        if (!isPlainObject(patch)) {
          return;
        }

        state.manifestState = {
          ...state.manifestState,
          ...patch,
        };
      },
      status() {
        return snapshotState(state);
      },
      async stop() {
        if (state.stopPromise) {
          return await state.stopPromise;
        }

        state.stopPromise = (async () => {
          state.phase = state.phase === "error" ? "error" : "stopping";
          if (state.backgroundPollTimer) {
            clearInterval(state.backgroundPollTimer);
            state.backgroundPollTimer = null;
          }

          await closeServer(state.discoveryServer);

          await terminateChildProcess(state.childProcess);
          await rm(runtimeDir, { recursive: true, force: true });

          state.phase = "stopped";
          state.bridgeState = normalizedBackboneServers.length > 0 ? "disconnected" : "disconnected";
        })();

        return await state.stopPromise;
      },
    };
  } catch (error) {
    await closeServer(state.discoveryServer);
    await terminateChildProcess(state.childProcess);
    await rm(runtimeDir, { recursive: true, force: true });
    throw error;
  }
}

export async function enableAutoLeaf(options) {
  assertNodeRuntime("enableAutoLeaf()");
  validateAutoLeafOptions(options);

  const normalizedBackboneServers = (options.backboneServers || []).map(normalizeBackboneServerUrl);
  assertCompatibleBackboneServers(normalizedBackboneServers);
  const leaderMissingGraceMs = options.leaderMissingGraceMs || DEFAULT_LEADER_MISSING_GRACE_MS;
  const lanBindAddress = chooseLanAddress(options.lanBindAddress);
  const advertisedHostname = options.advertisedHostname || lanBindAddress;
  const { nodeId, nodeIdFile } = await resolveStableNodeId(options.cacheDir, options.nodeId);
  const coordinationBus = await acquireSharedMulticastBus("kinopio-auto-leaf-coordination", {
    groupAddress: AUTO_COORDINATION_GROUP,
    port: AUTO_COORDINATION_PORT,
  });
  const mdnsBus = await acquireSharedMulticastBus("kinopio-auto-leaf-mdns", {
    groupAddress: AUTO_MDNS_GROUP,
    port: AUTO_MDNS_PORT,
    optional: true,
  });

  const agent = {
    options,
    nodeId,
    nodeIdFile,
    discoveryNamespace: options.discoveryNamespace,
    normalizedBackboneServers,
    leaderMissingGraceMs,
    lanBindAddress,
    advertisedHostname,
    coordinationBus,
    mdnsBus,
    stateName: "discovering",
    currentLeaderRecord: null,
    currentLeaderManifest: null,
    peerRecords: new Map(),
    mdnsRecords: new Map(),
    localLeaf: null,
    localLeaderEpoch: 0,
    localLeaseExpiresAt: null,
    maxObservedLeaderEpoch: 0,
    backboneRttMs: null,
    lastBackboneProbeError: null,
    preemptionStreak: 0,
    missingLeaderSince: null,
    lastError: null,
    lastLeafStartFailureAt: 0,
    discoverySettledAt: Date.now() + DEFAULT_DISCOVERY_SETTLE_MS,
    stopped: false,
    heartbeatTimer: null,
    mdnsQueryTimer: null,
    probeTimer: null,
    evaluationTimer: null,
    stopPromise: null,
    evaluationPromise: null,
    leafStartPromise: null,
    backboneProbePromise: null,
    coordinationUnsubscribe: null,
    mdnsUnsubscribe: null,
  };

  agent.coordinationUnsubscribe = coordinationBus.subscribe((message) => {
    const payload = safeParseJson(message.toString("utf8"));
    if (!isPlainObject(payload)) return;
    if (payload.kind !== "kinopio-auto-leaf-heartbeat") return;
    if (payload.protocolVersion !== AUTO_PROTOCOL_VERSION) return;

    const record = createPeerRecordFromPayload(payload);
    if (!record || record.nodeId === agent.nodeId || record.discoveryNamespace !== agent.discoveryNamespace) {
      return;
    }

    noteObservedEpoch(agent, record);
    rememberPeerRecord(agent.peerRecords, record);
    void evaluateAutoLeafAgent(agent);
  });

  agent.mdnsUnsubscribe = mdnsBus.subscribe((message) => {
    const packet = parseMdnsPacket(message);
    for (const manifest of extractKinopioLeafManifests(packet)) {
      const record = createPeerRecordFromManifest(manifest);
      if (!record || record.nodeId === agent.nodeId || record.discoveryNamespace !== agent.discoveryNamespace) {
        continue;
      }

      noteObservedEpoch(agent, record);
      rememberPeerRecord(agent.mdnsRecords, record);
    }
    void evaluateAutoLeafAgent(agent);
  });

  agent.heartbeatTimer = setInterval(() => {
    broadcastCoordinationHeartbeat(agent).catch((error) => {
      agent.lastError = toErrorMessage(error);
    });
    if (agent.stateName === "leader") {
      broadcastMdnsAnnouncement(agent).catch((error) => {
        agent.lastError = toErrorMessage(error);
      });
    }
  }, DEFAULT_COORDINATION_HEARTBEAT_MS);
  agent.heartbeatTimer.unref?.();

  agent.mdnsQueryTimer = setInterval(() => {
    queryMdns(agent).catch((error) => {
      agent.lastError = toErrorMessage(error);
    });
  }, DEFAULT_DISCOVERY_QUERY_INTERVAL_MS);
  agent.mdnsQueryTimer.unref?.();

  agent.probeTimer = setInterval(() => {
    refreshAutoLeafBackboneRtt(agent).catch((error) => {
      agent.lastError = toErrorMessage(error);
    });
  }, DEFAULT_BACKBONE_PROBE_INTERVAL_MS);
  agent.probeTimer.unref?.();

  agent.evaluationTimer = setInterval(() => {
    evaluateAutoLeafAgent(agent).catch((error) => {
      agent.lastError = toErrorMessage(error);
    });
  }, AUTO_AGENT_TICK_MS);
  agent.evaluationTimer.unref?.();

  await Promise.all([
    refreshAutoLeafBackboneRtt(agent),
    queryMdns(agent),
    broadcastCoordinationHeartbeat(agent),
  ]);
  await evaluateAutoLeafAgent(agent);

  return {
    state() {
      return agent.stateName;
    },
    role() {
      return mapAutoLeafRole(agent.stateName);
    },
    currentLeader() {
      return agent.currentLeaderManifest;
    },
    status() {
      return createAutoLeafStatusSnapshot(agent);
    },
    async stop() {
      if (agent.stopPromise) {
        return await agent.stopPromise;
      }

      agent.stopPromise = (async () => {
        agent.stopped = true;
        agent.stateName = "stopped";
        clearInterval(agent.heartbeatTimer);
        clearInterval(agent.mdnsQueryTimer);
        clearInterval(agent.probeTimer);
        clearInterval(agent.evaluationTimer);
        agent.coordinationUnsubscribe?.();
        agent.mdnsUnsubscribe?.();

        await agent.leafStartPromise?.catch(() => null);
        await stopLocalLeaf(agent);
        await coordinationBus.release();
        await mdnsBus.release();
        updateCurrentLeader(agent, null);
      })();

      return await agent.stopPromise;
    },
  };
}
