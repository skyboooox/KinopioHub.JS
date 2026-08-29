import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";

import {
  NATS_SERVER_VERSION,
  WELL_KNOWN_MANIFEST_PATH,
  ensureNatsServerBinary,
  normalizeBackboneServerUrl,
} from "./runtime.mjs";
import {
  assertCompatibleBackboneServers,
  chooseLanAddress,
  createRuntimeDirectory,
  createRuntimePaths,
  ensureRuntimeFolders,
  isWebSocketTlsEnabled,
  renderLeafConfig,
  resolveLeafPorts,
  validateLeafNodeOptions,
} from "./config.mjs";
import { ensureTlsFiles } from "./tls.mjs";
import { normalizeEpoch, normalizeFiniteRtt } from "../shared/election.mjs";
import { DEFAULT_DISCOVERY_MANIFEST_TTL_MS } from "../shared/manifest.mjs";
import { assertNodeRuntime, isPlainObject, sleep } from "../shared/assert.mjs";
import {
  fetchJson,
  probeDiscoveryEndpoint,
  probeMonitorHealth,
  probeNatsClient,
  probeTcpListener,
  probeTlsListener,
} from "./probes.mjs";
import { pushOutputLine, terminateChildProcess } from "./process.mjs";

const DEFAULT_LEAF_READY_TIMEOUT_MS = 20_000;
const DEFAULT_BRIDGE_POLL_INTERVAL_MS = 1_000;

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
    bridgeState: state.bridgeState,
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
    backboneServers: [...state.backboneServers],
    ports: { ...state.ports },
    configFile: state.configFile,
    logFile: state.logFile,
    pidFile: state.pidFile,
    storeDir: state.storeDir,
    processId: state.processId,
    processExitCode: state.processExitCode,
    lastError: state.lastError,
    lastBridgeError: state.lastBridgeError,
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
    server.closeAllConnections?.();
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

async function startLeafNodeAttempt(options) {
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
    if (error && typeof error === "object") {
      error.outputTail = [...state.outputTail];
    }
    await closeServer(state.discoveryServer);
    await terminateChildProcess(state.childProcess);
    await rm(runtimeDir, { recursive: true, force: true });
    throw error;
  }
}

export async function startLeafNode(options) {
  const hasExplicitPorts = options?.ports && Object.keys(options.ports).length > 0;
  const maxAttempts = hasExplicitPorts ? 1 : 3;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await startLeafNodeAttempt(options);
    } catch (error) {
      lastError = error;
      const outputTail = Array.isArray(error?.outputTail) ? error.outputTail.join("\n") : "";
      if (!/address already in use|bind: /iu.test(outputTail)) {
        throw error;
      }
    }
  }

  throw lastError;
}
