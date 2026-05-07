import { wsconnect } from "@nats-io/nats-core";
import { event } from "skyboxtool";

export const KINOPIO_STATE_EVENT = "kinopio.state";

const DEFAULT_SERVERS = ["wss://demo.nats.io:8443", "wss://demo.nats.io:4443"];
const SERVER_SELECTION_MODES = new Set(["ordered", "random", "latency"]);
const DEFAULT_SERVER_SELECTION_MODE = "latency";
const LATENCY_REPROBE_INTERVAL_MS = 10 * 60 * 1000;
const LATENCY_SWITCH_THRESHOLD_MS = 30;
const DEFAULT_DISCOVERY_MANIFEST_PATH = "/.well-known/kinopio-leader.json";
const DEFAULT_DISCOVERY_CACHE_TTL_MS = 5_000;
const DEFAULT_LOCAL_SWITCH_TIMEOUT_MS = 1_500;
const BROWSER_CONNECT_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:", "nats:", "tls:"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function uniqueServers(servers) {
  return [...new Set(servers)];
}

function normalizeBrowserConnectServer(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  try {
    const normalized = value.trim();
    const parsed = new URL(normalized);
    if (!BROWSER_CONNECT_PROTOCOLS.has(parsed.protocol)) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

function normalizeDiscoveryManifest(manifest) {
  if (!isPlainObject(manifest)) {
    return null;
  }

  const wssUrl = normalizeBrowserConnectServer(manifest.wssUrl);
  const expiresAtCandidate =
    typeof manifest.expiresAt === "string" && manifest.expiresAt.trim() !== ""
      ? manifest.expiresAt
      : typeof manifest.leaseExpiresAt === "string" && manifest.leaseExpiresAt.trim() !== ""
        ? manifest.leaseExpiresAt
        : null;
  const expiresAtTimestamp = expiresAtCandidate ? Date.parse(expiresAtCandidate) : Number.NaN;
  if (!wssUrl || !Number.isFinite(expiresAtTimestamp) || expiresAtTimestamp <= Date.now()) {
    return null;
  }

  return {
    version: typeof manifest.version === "string" ? manifest.version : "1",
    expiresAt: new Date(expiresAtTimestamp).toISOString(),
    leaderEpoch: Number.isInteger(manifest.leaderEpoch) && manifest.leaderEpoch >= 0 ? manifest.leaderEpoch : 0,
    advertisedHostname: typeof manifest.advertisedHostname === "string" ? manifest.advertisedHostname : "",
    wssUrl,
    fallbackServers: Array.isArray(manifest.fallbackServers)
      ? manifest.fallbackServers
        .map(normalizeBrowserConnectServer)
        .filter(Boolean)
      : [],
    backboneRttMs: isPositiveFiniteNumber(manifest.backboneRttMs) || manifest.backboneRttMs === 0
      ? manifest.backboneRttMs
      : null,
    discoveryUrl:
      typeof manifest.discoveryUrl === "string" && manifest.discoveryUrl.trim() !== ""
        ? manifest.discoveryUrl
        : undefined,
    leaseExpiresAt:
      typeof manifest.leaseExpiresAt === "string" && manifest.leaseExpiresAt.trim() !== ""
        ? manifest.leaseExpiresAt
        : undefined,
  };
}

/**
 * KinopioHub - A modern NATS client for real-time communication
 * 
 * @class KinopioHub
 * @description 
 * 
 * @example
 * ```js
 * // Create a new instance
 * const hub = new KinopioHub({
 *   servers: ["wss://nats.example.com:443"],
 *   debug: true
 * });
 * 
 * // Use scoped variables
 * const myScope = hub.getScope("myScope");
 * const myVar = myScope.getVariable("myVar");
 * 
 * // Publish data
 * await myVar.pub({ message: "Hello!" });
 * 
 * // Subscribe to updates
 * await myVar.sub(data => {
 *   console.log("Received:", data);
 * });
 * ```
 */
export class KinopioHub {
  // Core connection and state management
  #activeConnection = null;
  #candidateConnection = null;
  #activeConnectionPlan = null;
  #pendingConnectionPlan = null;
  #options;
  #connectionPromise = null;
  #switchLock = Promise.resolve();
  #healthCheckActive = false;
  #activeTimers = new Set();
  #scopes = new Map();
  #variables = new Set();
  #subscriptions = new Map();
  #retryAttempt = 0;
  #currentRetryDelay = 0;
  #latencyProbeTimer = null;
  #discoveryProbeTimer = null;
  #discoveryProbePromise = null;
  #discoveryManifestCache = null;
  #discoveryManifestCacheExpiresAt = 0;
  
  /**
   * Creates a new KinopioHub instance
   * @param {Object} options - Configuration options
   * @param {boolean} [options.debug=false] - Enable debug logging
   * @param {string[]} [options.servers=["wss://demo.nats.io:8443", "wss://demo.nats.io:4443"]] - NATS server URLs
   * @param {boolean} [options.noEcho=false] - Don't receive own published messages
   * @param {"ordered"|"random"|"latency"} [options.serverSelectionMode="latency"] - Strategy used to order multiple candidate servers before connecting
   * @param {boolean} [options.noRandomize] - Deprecated compatibility alias. `true` maps to `ordered`, `false` maps to `random` when `serverSelectionMode` is unset
   * @param {number} [options.maxReconnectAttempts=-1] - Max reconnection attempts (-1 for infinite)
   * @param {boolean} [options.waitOnFirstConnect=true] - Wait for first connection
   * @param {number} [options.reconnectTimeout=5000] - Reconnection timeout in ms
   * @param {number} [options.reconnectTimeWait=500] - Wait time between reconnects in ms
   * @param {number} [options.timeout=3000] - Operation timeout in ms
   * @param {boolean} [options.autoConnect=true] - Start connecting immediately
   * @param {boolean} [options.autoRetry=true] - Enable automatic retry on connection failure
   * @param {number} [options.retryDelay=1000] - Initial retry delay in ms
   * @param {number} [options.maxRetryDelay=30000] - Maximum retry delay in ms
   * @param {number} [options.retryBackoffFactor=1.5] - Backoff multiplier for retry delays
   * @param {Object} [options.discovery] - Browser-side local leaf discovery controls
   * @param {boolean} [options.discovery.enabled] - Enable the browser-side local leaf enhancement path
   * @param {string} [options.discovery.manifestUrl] - Override the discovery manifest URL used by the browser-side local probe flow
   * @param {boolean} [options.discovery.backgroundLocalProbe=true] - Keep probing in the background after the initial remote connection is ready
   * @param {number} [options.discovery.localSwitchTimeoutMs=1500] - Timeout for switching the current browser session to a discovered local leaf
   * @param {number} [options.discovery.cacheTtlMs=5000] - Cache TTL for browser-side manifest reuse and re-probe cadence
   * @param {Object} [options.codec] - Custom codec with encode(data) and decode(bytes)
   * @param {Function} [options.jsonReplacer] - JSON.stringify replacer
   * @param {Function} [options.jsonReviver] - JSON.parse reviver
   */
  constructor(options = {}) {
    // Default connection options
    this.#options = {
      debug: false,
      servers: [...DEFAULT_SERVERS],
      noEcho: false,
      serverSelectionMode: DEFAULT_SERVER_SELECTION_MODE,
      noRandomize: undefined,
      maxReconnectAttempts: -1,
      waitOnFirstConnect: true,
      reconnectTimeout: 5000,
      reconnectTimeWait: 500,
      pingInterval: 3000,
      maxPingOut: 3,
      timeout: 3000,
      healthReport: 5000,
      autoConnect: true,
      autoRetry: true,
      retryDelay: 1000,
      maxRetryDelay: 30000,
      retryBackoffFactor: 1.5,
      discovery: undefined,
      jsonReplacer: undefined,
      jsonReviver: undefined,
      codec: undefined,
      ...options,
    };

    // Environment detection
    this.isBrowser = this.#detectBrowser();
    this.textDecoder = this.#initTextDecoder();
    this.textEncoder = this.#initTextEncoder();
    
    // Initialize state
    this.state = "disconnected";
    this.isConnected = false;
    this.debug = this.#options.debug;
    
    // Start connection
    if (this.#options.autoConnect !== false) {
      this.#initConnection();
    }
    
    // Enable dynamic scope access
    return this.#createProxy();
  }

  // Check if running in browser environment
  #detectBrowser() {
    try {
      return typeof window !== "undefined" && 
             typeof window.document !== "undefined" &&
             typeof window.location !== "undefined";
    } catch {
      return false;
    }
  }

  // Initialize text decoder with fallback
  #initTextDecoder() {
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder("utf-8");
    }
    
    // Enhanced fallback with better error handling
    return {
      decode: (uint8Array) => {
        try {
          return String.fromCharCode(...uint8Array);
        } catch {
          // Fallback for large arrays
          return Array.from(uint8Array, byte => String.fromCharCode(byte)).join('');
        }
      }
    };
  }

  // Initialize text encoder with fallback
  #initTextEncoder() {
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder();
    }
    
    return {
      encode: (text) => {
        const result = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) {
          result[i] = text.charCodeAt(i);
        }
        return result;
      }
    };
  }

  // Timer management
  #createTimer(callback, delay) {
    const timerId = setTimeout(() => {
      this.#activeTimers.delete(timerId);
      callback();
    }, delay);
    this.#activeTimers.add(timerId);
    return timerId;
  }

  #clearTimer(timerId) {
    if (timerId && this.#activeTimers.has(timerId)) {
      clearTimeout(timerId);
      this.#activeTimers.delete(timerId);
    }
  }

  #clearAllTimers() {
    this.#activeTimers.forEach(timerId => clearTimeout(timerId));
    this.#activeTimers.clear();
  }

  #clearLatencyProbeTimer() {
    if (!this.#latencyProbeTimer) return;
    this.#clearTimer(this.#latencyProbeTimer);
    this.#latencyProbeTimer = null;
  }

  #clearDiscoveryProbeTimer() {
    if (!this.#discoveryProbeTimer) return;
    this.#clearTimer(this.#discoveryProbeTimer);
    this.#discoveryProbeTimer = null;
  }

  #clearDiscoveryManifestCache() {
    this.#discoveryManifestCache = null;
    this.#discoveryManifestCacheExpiresAt = 0;
  }

  #resolveDiscoveryOptions() {
    const discovery = this.#options.discovery;
    if (!this.isBrowser || !isPlainObject(discovery) || discovery.enabled !== true) {
      return null;
    }

    let manifestUrl = null;

    if (typeof discovery.manifestUrl === "string" && discovery.manifestUrl.trim() !== "") {
      try {
        manifestUrl = new URL(discovery.manifestUrl.trim(), globalThis.window?.location?.href).toString();
      } catch {
        manifestUrl = null;
      }
    } else {
      try {
        manifestUrl = new URL(DEFAULT_DISCOVERY_MANIFEST_PATH, globalThis.window?.location?.href).toString();
      } catch {
        manifestUrl = null;
      }
    }

    if (!manifestUrl) {
      return null;
    }

    return {
      manifestUrl,
      backgroundLocalProbe: discovery.backgroundLocalProbe !== false,
      localSwitchTimeoutMs: isPositiveFiniteNumber(discovery.localSwitchTimeoutMs)
        ? Math.floor(discovery.localSwitchTimeoutMs)
        : DEFAULT_LOCAL_SWITCH_TIMEOUT_MS,
      cacheTtlMs: isPositiveFiniteNumber(discovery.cacheTtlMs)
        ? Math.floor(discovery.cacheTtlMs)
        : DEFAULT_DISCOVERY_CACHE_TTL_MS,
    };
  }

  #createBaseConnectOptions() {
    const {
      serverSelectionMode,
      autoConnect,
      autoRetry,
      retryDelay,
      maxRetryDelay,
      retryBackoffFactor,
      healthReport,
      discovery,
      codec,
      jsonReplacer,
      jsonReviver,
      ...connectOptions
    } = this.#options;

    return connectOptions;
  }

  // Create proxy for dynamic property access
  #createProxy() {
    return new Proxy(this, {
      get: (target, prop) => {
        if (prop in target || typeof prop === "symbol") {
          const value = target[prop];
          if (typeof value === 'function') {
            return value.bind(target);
          }
          return value;
        }
        return target.getScope(prop);
      }
    });
  }

  // Initialize NATS connection
  #initConnection() {
    this.#createTimer(() => this.connect(), 0);
  }

  #normalizeServerCandidates(servers = this.#options.servers) {
    const inputServers = Array.isArray(servers) ? servers : [servers];
    const candidates = inputServers
      .filter(server => typeof server === "string")
      .map(server => server.trim())
      .filter(Boolean);

    return candidates.length > 0 ? candidates : [...DEFAULT_SERVERS];
  }

  #resolveServerSelectionMode() {
    const configuredMode = this.#options.serverSelectionMode;
    if (SERVER_SELECTION_MODES.has(configuredMode)) {
      return configuredMode;
    }

    if (typeof this.#options.noRandomize === "boolean") {
      return this.#options.noRandomize ? "ordered" : "random";
    }

    return DEFAULT_SERVER_SELECTION_MODE;
  }

  #shuffleCandidates(candidates) {
    const shuffled = [...candidates];
    for (let index = shuffled.length - 1; index > 0; index--) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    return shuffled;
  }

  #orderConnectionCandidates(candidates, mode) {
    if (candidates.length <= 1) {
      return [...candidates];
    }

    switch (mode) {
      case "random":
        return this.#shuffleCandidates(candidates);
      case "ordered":
      case "latency":
      default:
        return [...candidates];
    }
  }

  async #probeServerLatency(server, index) {
    let connection = null;

    try {
      connection = await wsconnect({
        ...this.#createBaseConnectOptions(),
        servers: [server],
        noRandomize: true,
        reconnect: false,
        maxReconnectAttempts: 0,
        waitOnFirstConnect: false,
      });

      // Prime the connection with an explicit flush, then record a dedicated
      // PING/PONG-based RTT from the official client helper.
      await connection.flush();
      const rtt = await connection.rtt();
      if (!Number.isFinite(rtt)) {
        throw new Error(`Invalid RTT result for ${server}`);
      }

      return {
        server,
        index,
        healthy: true,
        rtt,
        error: null,
      };
    } catch (error) {
      return {
        server,
        index,
        healthy: false,
        rtt: Number.POSITIVE_INFINITY,
        error,
      };
    } finally {
      await this.#closeConnection(connection, `latency probe for ${server}`);
    }
  }

  async #probeLatencyCandidates(candidates) {
    const probeResults = await Promise.all(
      candidates.map((server, index) => this.#probeServerLatency(server, index)),
    );

    const healthyResults = probeResults
      .filter(result => result.healthy)
      .sort((left, right) => left.rtt - right.rtt || left.index - right.index);
    const failedResults = probeResults
      .filter(result => !result.healthy)
      .sort((left, right) => left.index - right.index);
    const allFailed = healthyResults.length === 0;

    return {
      allFailed,
      probeResults,
      orderedCandidates: allFailed
        ? [...candidates]
        : [...healthyResults, ...failedResults].map(result => result.server),
    };
  }

  async #createConnectionPlan() {
    const sourceCandidates = this.#normalizeServerCandidates();
    const mode = this.#resolveServerSelectionMode();
    let orderedCandidates = this.#orderConnectionCandidates(sourceCandidates, mode);
    let probeResults = [];
    let latencyProbePending = mode === "latency" && orderedCandidates.length > 1;
    let latencyProbeFailedAll = false;

    if (latencyProbePending) {
      const probeSummary = await this.#probeLatencyCandidates(sourceCandidates);
      orderedCandidates = probeSummary.orderedCandidates;
      probeResults = probeSummary.probeResults;
      latencyProbeFailedAll = probeSummary.allFailed;
      latencyProbePending = false;

      if (latencyProbeFailedAll) {
        this.#log(
          "warn",
          "Latency probe failed for every configured server, falling back to the original candidate order",
          sourceCandidates,
        );
      } else {
        this.#log(
          "info",
          "Latency probe ordered candidate servers",
          probeResults.map(result => ({
            server: result.server,
            healthy: result.healthy,
            rtt: result.healthy ? result.rtt : null,
          })),
        );
      }
    }

    return {
      mode,
      sourceCandidates,
      orderedCandidates,
      createdAt: Date.now(),
      latencyProbePending,
      latencyProbeFailedAll,
      probeResults,
    };
  }

  #createConnectOptions(connectionPlan) {
    return {
      ...this.#createBaseConnectOptions(),
      servers: connectionPlan.orderedCandidates,
      // We control candidate order in the library, so the underlying client
      // should preserve it for both the initial connect and later reconnects.
      noRandomize: true,
    };
  }

  #runWithSwitchLock(task) {
    const run = this.#switchLock.then(task, task);
    this.#switchLock = run.then(() => undefined, () => undefined);
    return run;
  }

  async #setCandidateConnection(connection, connectionPlan) {
    await this.#runWithSwitchLock(async () => {
      this.#candidateConnection = connection;
      this.#pendingConnectionPlan = connectionPlan;
    });
  }

  async #promoteCandidateConnection(connection, connectionPlan) {
    await this.#runWithSwitchLock(async () => {
      this.#activeConnection = connection;
      this.#activeConnectionPlan = connectionPlan;
      this.#candidateConnection = null;
      this.#pendingConnectionPlan = null;
    });
  }

  async #closeConnection(connection, label) {
    if (!connection) return;

    try {
      await connection.drain();
    } catch (error) {
      this.#log("warn", `Drain failed for ${label}:`, error);
      try {
        await connection.close();
      } catch (closeError) {
        this.#log("warn", `Close failed for ${label}:`, closeError);
      }
    }
  }

  async #discardCandidateConnection(connection) {
    if (!connection) return;

    await this.#runWithSwitchLock(async () => {
      if (this.#candidateConnection === connection) {
        this.#candidateConnection = null;
        this.#pendingConnectionPlan = null;
      }
    });

    await this.#closeConnection(connection, "candidate connection");
  }

  #supportsLatencyMonitoring(connectionPlan = this.#activeConnectionPlan) {
    return connectionPlan?.mode === "latency" && connectionPlan?.sourceCandidates?.length > 1;
  }

  #isUsingDiscoveryLocalConnection(connectionPlan = this.#activeConnectionPlan) {
    if (!connectionPlan?.discoveryLocalServer || !this.#activeConnection) {
      return false;
    }

    const currentServer = this.#activeConnection.getServer?.() ?? connectionPlan.connectedServer ?? null;
    return currentServer === connectionPlan.discoveryLocalServer;
  }

  #scheduleLatencyProbeCycle() {
    this.#clearLatencyProbeTimer();

    if (!this.#supportsLatencyMonitoring() || !this.#activeConnection) {
      return;
    }

    this.#latencyProbeTimer = this.#createTimer(() => {
      this.#latencyProbeTimer = null;
      this.#runLatencyProbeCycle().catch(error => {
        this.#log("error", "Latency re-probe cycle failed:", error);
      });
    }, LATENCY_REPROBE_INTERVAL_MS);
  }

  #scheduleDiscoveryProbeCycle(delayMs = 0) {
    this.#clearDiscoveryProbeTimer();

    const discoveryOptions = this.#resolveDiscoveryOptions();
    if (!discoveryOptions?.backgroundLocalProbe || !this.#activeConnection || this.state !== "connected") {
      return;
    }

    this.#discoveryProbeTimer = this.#createTimer(() => {
      this.#discoveryProbeTimer = null;
      this.#runDiscoveryProbeCycle().catch(error => {
        this.#log("warn", "Background local leaf probe failed:", error);
      });
    }, Math.max(0, delayMs));
  }

  async #runLatencyProbeCycle() {
    try {
      await this.#maybeHotSwitchLatencyConnection();
    } finally {
      if (this.#activeConnection && this.#supportsLatencyMonitoring()) {
        this.#scheduleLatencyProbeCycle();
      }
    }
  }

  async #rebuildRegisteredState(connection) {
    for (const variable of this.#variables) {
      await variable.rebindToConnection(connection);
    }
  }

  async #maybeHotSwitchLatencyConnection() {
    const currentPlan = this.#activeConnectionPlan;

    if (!this.#activeConnection || this.state !== "connected" || !this.#supportsLatencyMonitoring(currentPlan)) {
      return false;
    }

    if (this.#isUsingDiscoveryLocalConnection(currentPlan)) {
      this.#log("debug", "Skipping background latency hot switch while a discovered local leaf is active");
      return false;
    }

    const probeSummary = await this.#probeLatencyCandidates(currentPlan.sourceCandidates);
    if (probeSummary.allFailed) {
      this.#log("warn", "Background latency re-probe failed for every configured server; keeping the current connection");
      return false;
    }

    const healthyResults = probeSummary.probeResults
      .filter(result => result.healthy)
      .sort((left, right) => left.rtt - right.rtt || left.index - right.index);
    const bestHealthy = healthyResults[0];
    const currentServer = this.#activeConnection.getServer?.() ?? currentPlan.connectedServer ?? currentPlan.orderedCandidates[0];
    const currentHealthy = healthyResults.find(result => result.server === currentServer) ?? null;

    if (!bestHealthy || bestHealthy.server === currentServer) {
      this.#log("debug", "Background latency re-probe kept the current active server", {
        currentServer,
        bestServer: bestHealthy?.server ?? null,
      });
      return false;
    }

    if (currentHealthy && currentHealthy.rtt - bestHealthy.rtt < LATENCY_SWITCH_THRESHOLD_MS) {
      this.#log("info", "Background latency re-probe found a faster server but it did not beat the switch threshold", {
        currentServer,
        currentRtt: currentHealthy.rtt,
        bestServer: bestHealthy.server,
        bestRtt: bestHealthy.rtt,
        thresholdMs: LATENCY_SWITCH_THRESHOLD_MS,
      });
      return false;
    }

    const nextPlan = {
      ...currentPlan,
      createdAt: Date.now(),
      orderedCandidates: probeSummary.orderedCandidates,
      probeResults: probeSummary.probeResults,
      latencyProbePending: false,
      latencyProbeFailedAll: false,
    };

    this.#log("info", "Hot switching to a lower-latency server", {
      from: currentServer,
      to: bestHealthy.server,
      currentRtt: currentHealthy?.rtt ?? null,
      nextRtt: bestHealthy.rtt,
      thresholdMs: LATENCY_SWITCH_THRESHOLD_MS,
    });

    await this.#switchActiveConnection(nextPlan);
    return true;
  }

  async #fetchDiscoveryManifest(discoveryOptions, { forceRefresh = false } = {}) {
    if (!forceRefresh && this.#discoveryManifestCacheExpiresAt > Date.now()) {
      return this.#discoveryManifestCache;
    }

    if (typeof fetch !== "function") {
      throw new Error("fetch() is not available in this runtime");
    }

    let timeoutId = null;
    let signal;

    if (typeof AbortController !== "undefined") {
      const controller = new AbortController();
      signal = controller.signal;
      timeoutId = this.#createTimer(() => {
        controller.abort(new Error("Discovery manifest fetch timed out"));
      }, discoveryOptions.localSwitchTimeoutMs);
    }

    try {
      const response = await fetch(discoveryOptions.manifestUrl, {
        method: "GET",
        cache: "no-store",
        signal,
      });

      if (response.status === 204 || response.status === 404) {
        this.#discoveryManifestCache = null;
        this.#discoveryManifestCacheExpiresAt = Date.now() + discoveryOptions.cacheTtlMs;
        return null;
      }

      if (!response.ok) {
        throw new Error(`Discovery manifest fetch failed with HTTP ${response.status}`);
      }

      const manifest = normalizeDiscoveryManifest(await response.json());
      this.#discoveryManifestCache = manifest;
      this.#discoveryManifestCacheExpiresAt = Date.now() + discoveryOptions.cacheTtlMs;
      return manifest;
    } finally {
      if (timeoutId) {
        this.#clearTimer(timeoutId);
      }
    }
  }

  #buildDiscoveryPreferredPlan(localServer, manifest, basePlan, manifestUrl) {
    const remoteSourceCandidates = uniqueServers(
      (basePlan?.sourceCandidates || this.#normalizeServerCandidates())
        .filter(server => server !== localServer),
    );
    const remoteOrderedCandidates = uniqueServers(
      (basePlan?.orderedCandidates || remoteSourceCandidates)
        .filter(server => server !== localServer),
    );

    return {
      ...(basePlan || {}),
      mode: basePlan?.mode || this.#resolveServerSelectionMode(),
      sourceCandidates: remoteSourceCandidates,
      orderedCandidates: uniqueServers([localServer, ...remoteOrderedCandidates]),
      createdAt: Date.now(),
      latencyProbePending: false,
      latencyProbeFailedAll: false,
      probeResults: basePlan?.probeResults || [],
      discoveryLocalServer: localServer,
      discoveryManifest: manifest,
      discoveryManifestUrl: manifestUrl,
      preferDiscoveryLocal: true,
    };
  }

  async #switchToRemoteDiscoveryFallback(discoveryOptions, reason) {
    const currentPlan = this.#activeConnectionPlan;
    const currentServer = this.#activeConnection?.getServer?.() ?? currentPlan?.connectedServer ?? null;

    if (!currentPlan?.discoveryLocalServer || currentServer !== currentPlan.discoveryLocalServer) {
      return false;
    }

    const remotePlan = await this.#createConnectionPlan();
    this.#log("info", "Discovery probe is falling back to the configured remote servers", {
      reason,
      from: currentServer,
      manifestUrl: discoveryOptions.manifestUrl,
    });
    await this.#switchActiveConnection(remotePlan, {
      timeoutMs: discoveryOptions.localSwitchTimeoutMs,
    });
    return true;
  }

  async #applyDiscoveryManifest(manifest, discoveryOptions) {
    const currentPlan = this.#activeConnectionPlan;
    const currentServer = this.#activeConnection?.getServer?.() ?? currentPlan?.connectedServer ?? null;

    if (!manifest) {
      return await this.#switchToRemoteDiscoveryFallback(discoveryOptions, "no usable local leader manifest");
    }

    const localServer = manifest.wssUrl;
    if (!localServer) {
      return await this.#switchToRemoteDiscoveryFallback(discoveryOptions, "manifest did not expose a usable wssUrl");
    }

    if (currentPlan?.discoveryLocalServer === localServer && currentServer === localServer) {
      currentPlan.discoveryManifest = manifest;
      currentPlan.discoveryManifestUrl = discoveryOptions.manifestUrl;
      return false;
    }

    const nextPlan = this.#buildDiscoveryPreferredPlan(
      localServer,
      manifest,
      currentPlan,
      discoveryOptions.manifestUrl,
    );

    try {
      await this.#switchActiveConnection(nextPlan, {
        timeoutMs: discoveryOptions.localSwitchTimeoutMs,
        expectedServer: localServer,
      });
      this.#log("info", "Background local leaf probe switched the current session to a discovered local leaf", {
        to: localServer,
        manifestUrl: discoveryOptions.manifestUrl,
      });
      return true;
    } catch (error) {
      this.#log("warn", "Background local leaf probe could not switch to the discovered local leaf; keeping the current connection", {
        to: localServer,
        manifestUrl: discoveryOptions.manifestUrl,
        error: error.message,
      });
      return false;
    }
  }

  async #runDiscoveryProbeCycle({ forceRefresh = false, reschedule = true } = {}) {
    const discoveryOptions = this.#resolveDiscoveryOptions();
    if (!discoveryOptions || !this.#activeConnection || this.state !== "connected") {
      return false;
    }

    if (this.#candidateConnection || this.#pendingConnectionPlan) {
      return false;
    }

    if (this.#discoveryProbePromise) {
      return await this.#discoveryProbePromise;
    }

    const cyclePromise = (async () => {
      try {
        const manifest = await this.#fetchDiscoveryManifest(discoveryOptions, { forceRefresh });
        return await this.#applyDiscoveryManifest(manifest, discoveryOptions);
      } catch (error) {
        this.#log("warn", "Background local leaf probe request failed; keeping the current connection", {
          manifestUrl: discoveryOptions.manifestUrl,
          error: error.message,
        });
        return false;
      } finally {
        if (reschedule && discoveryOptions.backgroundLocalProbe && this.#activeConnection) {
          this.#scheduleDiscoveryProbeCycle(discoveryOptions.cacheTtlMs);
        }
      }
    })().finally(() => {
      if (this.#discoveryProbePromise === cyclePromise) {
        this.#discoveryProbePromise = null;
      }
    });

    this.#discoveryProbePromise = cyclePromise;
    return await cyclePromise;
  }

  async #startDiscoveryFlowForActiveConnection({ immediateProbe = false } = {}) {
    const discoveryOptions = this.#resolveDiscoveryOptions();
    if (!discoveryOptions || !this.#activeConnection) {
      return;
    }

    this.#clearDiscoveryProbeTimer();

    if (this.#activeConnectionPlan?.discoveryLocalServer) {
      if (discoveryOptions.backgroundLocalProbe) {
        this.#scheduleDiscoveryProbeCycle(discoveryOptions.cacheTtlMs);
      }
      return;
    }

    if (discoveryOptions.backgroundLocalProbe) {
      this.#scheduleDiscoveryProbeCycle(immediateProbe ? 0 : discoveryOptions.cacheTtlMs);
      return;
    }

    await this.#runDiscoveryProbeCycle({
      forceRefresh: true,
      reschedule: false,
    });
  }

  async #openConnection(connectionPlan, label = "connection", timeoutMs = this.#options.timeout || 10000) {
    let timeoutId = null;
    let connectionTimedOut = false;
    let connection = null;

    try {
      const connectOptions = this.#createConnectOptions(connectionPlan);
      const connectPromise = wsconnect(connectOptions).then(async (nextConnection) => {
        if (connectionTimedOut) {
          await this.#closeConnection(nextConnection, `${label} after timeout`);
          return null;
        }
        return nextConnection;
      });
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = this.#createTimer(() => {
          connectionTimedOut = true;
          reject(new Error("NATS connection timeout"));
        }, timeoutMs);
      });

      connection = await Promise.race([connectPromise, timeoutPromise]);
      if (!connection) {
        throw new Error("NATS connection timeout");
      }

      return connection;
    } finally {
      if (timeoutId) this.#clearTimer(timeoutId);
    }
  }

  async #switchActiveConnection(connectionPlan, { timeoutMs, expectedServer } = {}) {
    const previousConnection = this.#activeConnection;
    let candidateConnection = null;

    try {
      candidateConnection = await this.#openConnection(connectionPlan, "candidate connection", timeoutMs);
      await this.#setCandidateConnection(candidateConnection, connectionPlan);
      await this.#verifyConnection(candidateConnection);
      await this.#rebuildRegisteredState(candidateConnection);
      await candidateConnection.flush();

      connectionPlan.connectedServer = candidateConnection.getServer?.() ?? connectionPlan.orderedCandidates[0];
      if (expectedServer && connectionPlan.connectedServer !== expectedServer) {
        throw new Error(
          `Expected discovery switch to connect ${expectedServer}, but the candidate connection settled on ${connectionPlan.connectedServer}`,
        );
      }

      await this.#promoteCandidateConnection(candidateConnection, connectionPlan);
      this.#startHealthCheck(candidateConnection);
      this.#scheduleLatencyProbeCycle();
      await this.#startDiscoveryFlowForActiveConnection({ immediateProbe: false });

      if (previousConnection && previousConnection !== candidateConnection) {
        await this.#closeConnection(previousConnection, "previous active connection after hot switch");
      }

      return candidateConnection;
    } catch (error) {
      if (candidateConnection) {
        await this.#discardCandidateConnection(candidateConnection);
      }
      throw error;
    }
  }

  registerVariable(variable) {
    this.#variables.add(variable);
  }

  unregisterVariable(variable) {
    this.#variables.delete(variable);
  }

  // Log messages with timestamp
  #log(level, message, ...args) {
    if (!this.debug && level !== "error") return;
    
    const timestamp = globalThis.Temporal?.Now?.instant()?.toString() ?? new Date().toISOString();
    const prefix = `[${timestamp}] [KinopioHub]`;
    
    const logActions = {
      error: () => console.error(`${prefix} ERROR:`, message, ...args),
      warn: () => console.warn(`${prefix} WARN:`, message, ...args),
      info: () => console.info(`${prefix} INFO:`, message, ...args),
      default: () => console.log(`${prefix} DEBUG:`, message, ...args)
    };
    
    (logActions[level] ?? logActions.default)();
  }

  /**
   * Gets or creates a new scope for variable management
   * @param {string} scopeName - Name of the scope
   * @returns {Scope} The scope instance
   */
  getScope(scopeName) {
    return this.#scopes.get(scopeName) ?? (() => {
      const scope = new Scope(this, scopeName);
      this.#scopes.set(scopeName, scope);
      this.#log("debug", `New scope: ${scopeName}`);
      return scope;
    })();
  }

  // Update connection state
  async #setState(newState) {
    if (this.state === newState) return;
    
    const oldState = this.state;
    this.state = newState;
    this.isConnected = newState === "connected";
    
    this.#log("info", `State: ${oldState} -> ${newState}`);
    
    try {
      event.emit(KINOPIO_STATE_EVENT, newState);
    } catch (error) {
      this.#log("error", "Failed to emit state event:", error);
    }
  }

  /**
   * Connects to the NATS server with infinite retry
   * @returns {Promise<void>} Resolves when connected
   * @throws {Error} If connection fails and autoRetry is disabled
   */
  async connect() {
    if (this.state === "connected") {
      this.#log("debug", "Connection exists");
      return;
    }

    if (this.#connectionPromise) {
      this.#log("debug", "Connecting in progress");
      return this.#connectionPromise;
    }

    this.#connectionPromise = this.#doConnect();
    
    try {
      await this.#connectionPromise;
    } catch (error) {
      // Only throw if autoRetry is disabled, otherwise #doConnect will keep retrying
      if (this.#options.autoRetry === false) {
        throw error;
      }
      // If autoRetry is enabled, the error should not reach here due to infinite retry loop
      this.#log("warn", "Unexpected error in connect() with autoRetry enabled:", error);
    } finally {
      this.#connectionPromise = null;
    }
  }

  // Establish NATS connection with infinite retry
  async #doConnect() {
    if (this.state === "connecting") return;
    
    await this.#setState("connecting");
    
    while (true) {
      let connectionPlan = null;
      let candidateConnection = null;
      
      try {
        this.#retryAttempt++;
        connectionPlan = await this.#createConnectionPlan();
        this.#log(
          "info",
          `Connecting to NATS (attempt ${this.#retryAttempt}) using ${connectionPlan.mode} mode`,
          connectionPlan.orderedCandidates,
        );
        candidateConnection = await this.#openConnection(connectionPlan, "initial connection");
        await this.#setCandidateConnection(candidateConnection, connectionPlan);
        await this.#verifyConnection(candidateConnection);
        await this.#rebuildRegisteredState(candidateConnection);
        await candidateConnection.flush();
        connectionPlan.connectedServer = candidateConnection.getServer?.() ?? connectionPlan.orderedCandidates[0];
        await this.#promoteCandidateConnection(candidateConnection, connectionPlan);
        this.#startHealthCheck(candidateConnection);
        this.#scheduleLatencyProbeCycle();
        await this.#setState("connected");
        await this.#startDiscoveryFlowForActiveConnection({ immediateProbe: true });
        
        // Reset retry state on successful connection
        this.#retryAttempt = 0;
        this.#currentRetryDelay = 0;
        
        this.#log("info", "NATS connected successfully");
        return;
        
      } catch (error) {
        if (candidateConnection) {
          await this.#discardCandidateConnection(candidateConnection);
        }
        
        this.#log("error", `Connection attempt ${this.#retryAttempt} failed:`, error.message);
        
        // Check if auto-retry is disabled
        if (this.#options.autoRetry === false) {
          await this.#setState("error");
          throw error;
        }
        
        // Calculate retry delay with exponential backoff + full jitter
        if (this.#retryAttempt === 1) {
          this.#currentRetryDelay = this.#options.retryDelay;
        } else {
          this.#currentRetryDelay = Math.min(
            this.#currentRetryDelay * this.#options.retryBackoffFactor,
            this.#options.maxRetryDelay
          );
        }
        // Full jitter: random(0, baseDelay)
        const jitter = Math.floor(Math.random() * this.#currentRetryDelay);
        this.#log("info", `Will retry in ${jitter}ms...`);
        
        // Wait before retry
        await new Promise(resolve => 
          this.#createTimer(resolve, jitter)
        );
        
        // Continue the retry loop
      }
    }
  }

  // Verify connection is working
  async #verifyConnection(connection = this.#activeConnection) {
    if (!connection) throw new Error("No NATS connection");
    
    try {
      connection.publish("_test.connection", new Uint8Array(0));
      this.#log("debug", "Connection verified");
    } catch (error) {
      this.#log("error", "Verification failed", error);
      throw new Error("Connection verification failed");
    }
  }

  /**
   * Waits for connection to be established
   * @param {number} [timeoutMs=10000] - Connection timeout in milliseconds
   * @returns {Promise<void>} Resolves when connected
   * @throws {Error} If connection fails or times out
   */
  async connected(timeoutMs = 10000) {
    if (this.state === "connected") return;
    
    const createPromise = () => {
      if (globalThis.Promise?.withResolvers) {
        return globalThis.Promise.withResolvers();
      }
      
      let resolve, reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };
    
    const { promise, resolve, reject } = createPromise();
    
    const timeoutId = this.#createTimer(() => {
      cleanup();
      reject(new Error(`Connection timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    let eventCleanup = null;
    
    const cleanup = () => {
      this.#clearTimer(timeoutId);
      eventCleanup?.();
    };

    const checkState = () => {
      switch (this.state) {
        case "connected":
          cleanup();
          resolve();
          return true;
        case "error":
          cleanup();
          reject(new Error("Connection failed"));
          return true;
        default:
          return false;
      }
    };
    
    if (checkState()) return promise;
    
    try {
      const handleStateChange = (newState) => {
        if (newState === "connected") {
          cleanup();
          resolve();
        } else if (newState === "error") {
          cleanup();
          reject(new Error("Connection failed"));
        }
      };
      
      event.on("kinopio.state", handleStateChange);
      eventCleanup = () => event.off("kinopio.state", handleStateChange);
      
    } catch (error) {
      this.#log("warn", "Using polling fallback", error);
      const poll = () => {
        if (!checkState()) {
          this.#createTimer(poll, 100);
        }
      };
      this.#createTimer(poll, 100);
    }
    
    return promise;
  }

  /**
   * Reconnects to the NATS server
   * @returns {Promise<void>} Resolves when reconnected
   * @throws {Error} If reconnection fails
   */
  async reconnect() {
    this.#log("info", "Reconnecting");
    
    try {
      await this.#cleanup();
      await this.connect();
    } catch (error) {
      this.#log("error", "Reconnect failed", error);
      await this.#setState("error");
      throw error;
    }
  }

  // Clean up resources
  async #cleanup() {
    this.#healthCheckActive = false;
    this.#clearLatencyProbeTimer();
    this.#clearDiscoveryProbeTimer();
    this.#clearAllTimers();
    this.#clearDiscoveryManifestCache();
    this.#discoveryProbePromise = null;

    const activeConnection = this.#activeConnection;
    const candidateConnection = this.#candidateConnection;

    this.#activeConnection = null;
    this.#candidateConnection = null;
    this.#activeConnectionPlan = null;
    this.#pendingConnectionPlan = null;

    await this.#closeConnection(candidateConnection, "candidate connection during cleanup");
    if (activeConnection && activeConnection !== candidateConnection) {
      await this.#closeConnection(activeConnection, "active connection during cleanup");
    }
    
    await this.#setState("disconnected");
  }

  // Start health monitoring
  #startHealthCheck(connection = this.#activeConnection) {
    if (!connection) return;
    this.#healthCheckActive = true;
    
    this.#runHealthCheck(connection).catch(error => {
      this.#log("error", "Health check failed:", error);
    });
  }

  // Monitor connection health
  async #runHealthCheck(connection) {
    try {
      for await (const status of connection.status()) {
        if (!this.#healthCheckActive || connection !== this.#activeConnection) break;
        
        const stateMap = {
          reconnect: "connected",
          disconnect: "disconnected", 
          reconnecting: "connecting"
        };
        
        const newState = stateMap[status.type];
        if (newState) {
          await this.#setState(newState);
        }
      }
    } catch (error) {
      if (this.#healthCheckActive && connection === this.#activeConnection) {
        this.#log("error", "Health check error:", error);
        await this.#setState("error");
      }
    }
  }

  /**
   * Sends a request and waits for response
   * @param {string} subject - Subject to send request to
   * @param {*} data - Data to send
   * @param {Object} [options={}] - Request options
   * @param {number} [options.timeout=5000] - Request timeout in milliseconds
   * @returns {Promise<*>} Response data
   * @throws {Error} If request fails or times out
   */
  async request(subject, data, options = {}) {
    await this.connected();
    
    const timeout = options.timeout || 5000;
    
    try {
      const message = this.#serializeData(data);
      this.#log("debug", `Sending request to ${subject}`, { data, timeout });
      
      const response = await this.#activeConnection.request(subject, message, { timeout });
      const responseData = this.#deserializeData(response.data);
      
      this.#log("debug", `Received response from ${subject}`, responseData);
      return responseData;
      
    } catch (error) {
      this.#log("error", `Request failed for ${subject}:`, error);
      throw error;
    }
  }

  // Serialize data for transmission (pluggable codec with JSON replacer)
  #serializeData(data) {
    if (data === null || data === undefined) {
      return new Uint8Array(0);
    }
    
    if (data instanceof Uint8Array) {
      return data;
    }
    
    if (typeof data === "string") {
      return this.textEncoder.encode(data);
    }
    
    if (this.#options.codec?.encode) {
      try {
        return this.#options.codec.encode(data);
      } catch (error) {
        this.#log("warn", `Custom codec.encode failed, fallback to JSON:`, error);
      }
    }
    
    try {
      const jsonString = JSON.stringify(data, this.#options.jsonReplacer);
      return this.textEncoder.encode(jsonString);
    } catch (error) {
      this.#log("warn", `Serialization failed, using string conversion:`, error);
      return this.textEncoder.encode(String(data));
    }
  }

  // Deserialize received data (pluggable codec with JSON reviver)
  #deserializeData(uint8Array) {
    if (!uint8Array || uint8Array.length === 0) {
      return null;
    }
    
    if (this.#options.codec?.decode) {
      try {
        return this.#options.codec.decode(uint8Array);
      } catch (error) {
        this.#log("warn", `Custom codec.decode failed, fallback to text/JSON:`, error);
      }
    }
    
    try {
      const text = this.textDecoder.decode(uint8Array);
      
      try {
        return JSON.parse(text, this.#options.jsonReviver);
      } catch {
        return text;
      }
    } catch (error) {
      this.#log("warn", `Deserialization failed:`, error);
      return uint8Array;
    }
  }

  // Public getters for internal state
  get nats() { return this.#activeConnection; }
  get subscriptions() { return this.#subscriptions; }
  get healthCheckActive() { return this.#healthCheckActive; }
  
  /**
   * Logs a message with timestamp
   * @param {"error"|"warn"|"info"|"debug"} level - Log level
   * @param {string} message - Message to log
   * @param {...*} args - Additional arguments
   */
  log(level, message, ...args) {
    return this.#log(level, message, ...args);
  }
  
  /**
   * Subscribe to state changes. Returns an unsubscribe function.
   * @param {(state: string) => void} listener
   * @returns {() => void}
   */
  onStateChange(listener) {
    event.on(KINOPIO_STATE_EVENT, listener);
    return () => event.off(KINOPIO_STATE_EVENT, listener);
  }
  
  /**
   * Unsubscribe a state change listener
   * @param {(state: string) => void} listener
   */
  offStateChange(listener) {
    event.off(KINOPIO_STATE_EVENT, listener);
  }
  
  /**
   * Serializes data for transmission
   * @param {*} data - Data to serialize
   * @returns {Uint8Array} Serialized data
   */
  serializeData(data) {
    return this.#serializeData(data);
  }
  
  /**
   * Deserializes received data
   * @param {Uint8Array} uint8Array - Data to deserialize
   * @returns {*} Deserialized data
   */
  deserializeData(uint8Array) {
    return this.#deserializeData(uint8Array);
  }

  /**
   * Cleans up resources and disconnects
   * @returns {Promise<void>} Resolves when cleanup is complete
   */
  async dispose() {
    this.#log("info", "Disposing");
    this.#healthCheckActive = false;
    
    // ES2024: Enhanced Map iteration for cleanup
    for (const [key, subscription] of this.#subscriptions) {
      try {
        subscription.unsubscribe();
      } catch (error) {
        this.#log("warn", `Failed to unsubscribe ${key}:`, error);
      }
    }
    this.#subscriptions.clear();
    
    // Cleanup scopes
    for (const [, scope] of this.#scopes) {
      scope.dispose();
    }
    this.#scopes.clear();
    
    await this.#cleanup();
  }
}

/**
 * Scope - Manages a group of variables within a namespace
 * 
 * @class Scope
 * @description A scope represents a namespace for variables, allowing organization
 * of related variables under a common prefix. Variables in a scope share the same
 * prefix in their NATS subjects.
 * 
 * @example
 * ```js
 * // Get a scope
 * const userScope = hub.getScope("users");
 * 
 * // Get variables in the scope
 * const onlineUsers = userScope.getVariable("online");
 * const userCount = userScope.getVariable("count");
 * ```
 */
class Scope {
  #hub;
  #scopeName;
  #variables = new Map();
  
  /**
   * Creates a new Scope instance
   * @param {KinopioHub} hub - The KinopioHub instance
   * @param {string} scopeName - Name of the scope
   */
  constructor(hub, scopeName) {
    this.#hub = hub;
    this.#scopeName = scopeName;
    
    return new Proxy(this, {
      get: (target, prop) => {
        if (prop in target || typeof prop === "symbol") {
          const value = target[prop];
          // Bind methods to preserve 'this' context and private field access
          if (typeof value === 'function') {
            return value.bind(target);
          }
          return value;
        }
        return target.getVariable(prop);
      }
    });
  }

  /**
   * Gets or creates a variable in this scope
   * @param {string} varName - Name of the variable
   * @returns {Variable} The variable instance
   */
  getVariable(varName) {
    return this.#variables.get(varName) ?? (() => {
      const variable = new Variable(this.#hub, this.#scopeName, varName);
      this.#variables.set(varName, variable);
      this.#hub.registerVariable(variable);
      return variable;
    })();
  }

  /**
   * Cleans up all variables in this scope
   */
  dispose() {
    for (const [, variable] of this.#variables) {
      this.#hub.unregisterVariable(variable);
      variable.dispose();
    }
    this.#variables.clear();
  }
}

class ManagedSubscriptionHandle {
  #active = true;
  #subscription = null;
  #iteratorEnabled = false;
  #iteratorQueue = [];
  #iteratorWaiters = [];
  #onUnsubscribe;

  constructor(onUnsubscribe = null) {
    this.#onUnsubscribe = onUnsubscribe;
  }

  get active() {
    return this.#active;
  }

  bind(subscription) {
    this.#subscription = subscription;
    return subscription;
  }

  notify(message) {
    if (!this.#active || !this.#iteratorEnabled) return;

    const waiter = this.#iteratorWaiters.shift();
    if (waiter) {
      waiter({ value: message, done: false });
      return;
    }

    this.#iteratorQueue.push(message);
  }

  unsubscribe() {
    if (!this.#active) return;

    this.#active = false;

    try {
      this.#subscription?.unsubscribe?.();
    } finally {
      this.#subscription = null;
      this.#iteratorQueue.length = 0;
      while (this.#iteratorWaiters.length > 0) {
        const waiter = this.#iteratorWaiters.shift();
        waiter?.({ value: undefined, done: true });
      }
      this.#onUnsubscribe?.();
    }
  }

  [Symbol.asyncIterator]() {
    this.#iteratorEnabled = true;

    return {
      next: () => {
        if (this.#iteratorQueue.length > 0) {
          return Promise.resolve({ value: this.#iteratorQueue.shift(), done: false });
        }

        if (!this.#active) {
          return Promise.resolve({ value: undefined, done: true });
        }

        return new Promise(resolve => {
          this.#iteratorWaiters.push(resolve);
        });
      },
      return: async () => {
        this.unsubscribe();
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}

/**
 * Variable - Handles pub/sub operations for a specific topic
 * 
 * @class Variable
 * @description A variable represents a specific topic in the NATS system,
 * providing methods for publishing, subscribing, and request/reply patterns.
 * Each variable automatically tracks its latest value and supports deduplication
 * of messages.
 * 
 * @example
 * ```js
 * // Get a variable
 * const counter = scope.getVariable("counter");
 * 
 * // Publish value
 * await counter.pub(42);
 * 
 * // Subscribe to changes
 * await counter.sub(value => {
 *   console.log("Counter changed:", value);
 * });
 * 
 * // Make request
 * const response = await counter.req({ action: "increment" });
 * 
 * // Set up service
 * await counter.serve(async (request) => {
 *   if (request.action === "increment") {
 *     return { value: currentValue + 1 };
 *   }
 * });
 * ```
 */
class Variable {
  #hub;
  #scopeName;
  #varName;
  #subject;
  #lastPublishedMessage = null;
  #subscriptionDefinitions = new Map();
  #latestValue = null;
  #valueSubscription = null;
  #valueTrackingConnection = null;
  #valueTrackingRetryTimer = null;
  #hasReceivedValue = false;
  #serviceDefinition = null;
  #disposed = false;
  
  /**
   * Creates a new Variable instance
   * @param {KinopioHub} hub - The KinopioHub instance
   * @param {string} scopeName - Name of the scope
   * @param {string} varName - Name of the variable
   */
  constructor(hub, scopeName, varName) {
    this.#hub = hub;
    this.#scopeName = scopeName;
    this.#varName = varName;
    this.#subject = `${scopeName}.${varName}`;
    
    this.#startValueTracking();
    
    // ES2024: Enhanced proxy with virtual readonly properties
    return new Proxy(this, {
      get: (target, prop) => {
        if (prop === 'value') {
          return target.#latestValue;
        }
        if (prop in target || typeof prop === "symbol") {
          const value = target[prop];
          // Bind methods to preserve 'this' context and private field access
          if (typeof value === 'function') {
            return value.bind(target);
          }
          return value;
        }
        return target[prop];
      },
      set: (target, prop, value) => {
        if (prop === 'value') {
          target.#hub.log("warn", `Cannot set readonly property 'value' on Variable ${target.#subject}`);
          return true;
        }
        if (prop === 'subject') {
          target.#hub.log("warn", `Cannot set readonly property 'subject' on Variable ${target.#subject}`);
          return true;
        }
        target[prop] = value;
        return true;
      }
    });
  }

  get subject() {
    return this.#subject;
  }

  #clearValueTrackingRetry() {
    if (!this.#valueTrackingRetryTimer) return;
    clearTimeout(this.#valueTrackingRetryTimer);
    this.#valueTrackingRetryTimer = null;
  }

  #scheduleValueTrackingRetry(delayMs) {
    if (this.#disposed || this.#valueTrackingRetryTimer) return;

    this.#valueTrackingRetryTimer = setTimeout(() => {
      this.#valueTrackingRetryTimer = null;
      this.#startValueTracking().catch(error => {
        this.#hub.log("debug", `Value tracking retry failed for ${this.#subject}:`, error.message);
      });
    }, delayMs);
  }

  async #startValueTracking() {
    if (this.#disposed || this.#valueSubscription) return;

    try {
      await this.#hub.connected();

      if (!this.#hub.nats) {
        this.#hub.log("debug", `NATS connection not available for ${this.#subject}, waiting...`);
        this.#scheduleValueTrackingRetry(1000);
        return;
      }

      await this.#rebindValueTracking(this.#hub.nats);
      this.#hub.log("debug", `Value tracking started: ${this.#subject}`);
    } catch (error) {
      if (this.#disposed) return;
      this.#hub.log("debug", `Value tracking failed: ${this.#subject}, will retry...`, error.message);
      this.#scheduleValueTrackingRetry(2000);
    }
  }

  async #rebindValueTracking(connection) {
    if (this.#disposed || !connection) return;
    if (this.#valueTrackingConnection === connection && this.#valueSubscription) return;

    const subscription = connection.subscribe(this.#subject);
    this.#valueSubscription = subscription;
    this.#valueTrackingConnection = connection;
    this.#clearValueTrackingRetry();

    this.#processValueMessages(subscription);
  }

  // Ensure NATS connection is available
  async #ensureNatsConnection(operation = "operation") {
    const maxRetries = 3;
    let retryCount = 0;
    
    while (retryCount < maxRetries) {
      await this.#hub.connected();
      if (this.#hub.nats) return;
      
      this.#hub.log("warn", `NATS connection not available for ${operation} on ${this.#subject}, retrying...`);
      retryCount++;
      
      if (retryCount >= maxRetries) {
        throw new Error(`NATS connection not available for ${operation} on ${this.#subject}`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 100 * retryCount));
    }
  }

  // Process incoming value updates
  async #processValueMessages(subscription) {
    try {
      for await (const message of subscription) {
        if (this.#disposed) break;

        try {
          const data = this.#deserializeData(message.data);
          this.#latestValue = data;
          this.#hasReceivedValue = true;
          this.#hub.log("debug", `Value updated: ${this.#subject}`, data);
        } catch (error) {
          this.#hub.log("error", `Value error: ${this.#subject}`, error);
        }
      }
    } catch (error) {
      if (!this.#disposed && this.#hub.healthCheckActive) {
        this.#hub.log("error", `Value tracking iterator error for ${this.#subject}:`, error);
      }
    }
  }

  async #subscribeDefinitionToConnection(definition, connection) {
    const subscription = connection.subscribe(this.#subject, definition.options);
    definition.currentSubscription = subscription;
    definition.handle.bind(subscription);
    this.#processMessages(subscription, definition);
    return subscription;
  }

  async #subscribeServiceDefinitionToConnection(definition, connection) {
    const subscription = connection.subscribe(this.#subject, definition.options);
    definition.currentSubscription = subscription;
    definition.handle.bind(subscription);
    this.#processServiceRequests(subscription, definition, connection);
    return subscription;
  }

  async rebindToConnection(connection) {
    if (this.#disposed || !connection) return;

    await this.#rebindValueTracking(connection);

    for (const definition of this.#subscriptionDefinitions.values()) {
      if (!definition.handle.active) continue;
      await this.#subscribeDefinitionToConnection(definition, connection);
    }

    if (this.#serviceDefinition?.handle.active) {
      await this.#subscribeServiceDefinitionToConnection(this.#serviceDefinition, connection);
    }
  }

  /**
   * Publishes a value to this variable's subject
   * @param {*} data - Data to publish
   * @param {Object} [options={}] - Publish options
   * @returns {Promise<void>} Resolves when published
   * @throws {Error} If publish fails
   */
  async pub(data, options = {}) {
    await this.#ensureNatsConnection("publishing");
    
    try {
      const message = this.#serializeData(data);
      
      if (this.#isDuplicateMessage(message)) {
        this.#hub.log("debug", `Skipped duplicate: ${this.#subject}`);
        return;
      }
      
      this.#hub.nats.publish(this.#subject, message, options);
      this.#lastPublishedMessage = message;
      this.#latestValue = data;
      this.#hasReceivedValue = true;
      
      this.#hub.log("debug", `Published: ${this.#subject}`, { message, options });
      
    } catch (error) {
      this.#hub.log("error", `Publish failed: ${this.#subject}`, error);
      throw error;
    }
  }

  /**
   * Subscribes to updates of this variable
   * @param {Function} callback - Callback function(data, message)
   * @param {Object} [options={}] - Subscription options
   * @param {string} [options.queue] - Queue group name
   * @param {number} [options.max] - Max messages to receive
   * @returns {Promise<Subscription>} Subscription object
   * @throws {Error} If subscription fails
   */
  async sub(callback, options = {}) {
    await this.#ensureNatsConnection("subscription");
    
    const subKey = this.#generateSubscriptionKey(options);
    
    const existing = this.#subscriptionDefinitions.get(subKey);
    if (existing) {
      this.#hub.log("debug", `Reusing sub: ${this.#subject}`);
      return existing.handle;
    }

    try {
      const handle = new ManagedSubscriptionHandle(() => {
        this.#subscriptionDefinitions.delete(subKey);
        this.#hub.subscriptions.delete(`${this.#subject}_${subKey}`);
      });
      const definition = {
        key: subKey,
        callback,
        options,
        handle,
        currentSubscription: null,
      };

      this.#subscriptionDefinitions.set(subKey, definition);
      this.#hub.subscriptions.set(`${this.#subject}_${subKey}`, handle);
      await this.#subscribeDefinitionToConnection(definition, this.#hub.nats);
      
      this.#hub.log("debug", `Subscribed: ${this.#subject}`, options);
      return handle;
      
    } catch (error) {
      this.#subscriptionDefinitions.get(subKey)?.handle.unsubscribe();
      this.#hub.log("error", `Sub failed: ${this.#subject}`, error);
      throw error;
    }
  }

  // Process subscription messages
  async #processMessages(subscription, definition) {
    try {
      for await (const message of subscription) {
        if (this.#disposed || !definition.handle.active) continue;

        // ES2024: Use structured error handling
        const processMessage = async () => {
          const data = this.#deserializeData(message.data);
          definition.handle.notify(message);
          await definition.callback(data, message);
        };
        
        await processMessage().catch(error => 
          this.#hub.log("error", `Msg error: ${this.#subject}`, error)
        );
      }
    } catch (error) {
      if (!this.#disposed && this.#hub.healthCheckActive && definition.handle.active) {
        this.#hub.log("error", `Iterator error: ${this.#subject}`, error);
      }
    }
  }

  /**
   * Sends a request and awaits response
   * @param {*} data - Request data
   * @param {Object} [options={}] - Request options
   * @param {number} [options.timeout=5000] - Request timeout in milliseconds
   * @returns {Promise<*>} Response data
   * @throws {Error} If request fails or times out
   */
  async req(data, options = {}) {
    await this.#ensureNatsConnection("request");
    
    const timeout = options.timeout || 5000;
    
    try {
      const message = this.#serializeData(data);
      const response = await this.#hub.nats.request(this.#subject, message, { timeout });
      
      this.#hub.log("debug", `Request sent to ${this.#subject}`, { message, timeout });
      return this.#deserializeData(response.data);
      
    } catch (error) {
      this.#hub.log("error", `Request failed for ${this.#subject}:`, error);
      throw error;
    }
  }

  /**
   * Sets up a request handler service
   * @param {Function} handler - Handler function(request, message)
   * @param {Object} [options={}] - Service options
   * @param {string} [options.queue] - Queue group name
   * @returns {Promise<Subscription>} Service subscription
   * @throws {Error} If service setup fails
   */
  async serve(handler, options = {}) {
    await this.#ensureNatsConnection("service");
    
    if (this.#serviceDefinition) {
      this.#hub.log("debug", `Stopping service: ${this.#subject}`);
      try {
        this.#serviceDefinition.handle.unsubscribe();
      } catch (error) {
        this.#hub.log("warn", `Failed to stop existing service:`, error);
      }
    }
    
    try {
      const normalizedOptions = {
        ...options,
        queue: options.queue || `${this.#subject}.service`
      };

      const handle = new ManagedSubscriptionHandle(() => {
        if (this.#serviceDefinition?.handle === handle) {
          this.#serviceDefinition = null;
          this.#hub.subscriptions.delete(`${this.#subject}_service`);
        }
      });
      const definition = {
        handler,
        options: normalizedOptions,
        handle,
        currentSubscription: null,
      };

      this.#serviceDefinition = definition;
      this.#hub.subscriptions.set(`${this.#subject}_service`, handle);
      await this.#subscribeServiceDefinitionToConnection(definition, this.#hub.nats);
      
      this.#hub.log("debug", `Service started: ${this.#subject}`, normalizedOptions);
      return handle;
      
    } catch (error) {
      if (this.#serviceDefinition) {
        this.#serviceDefinition.handle.unsubscribe();
      }
      this.#hub.log("error", `Service failed: ${this.#subject}`, error);
      throw error;
    }
  }

  // Process incoming service requests
  async #processServiceRequests(subscription, definition, connection) {
    try {
      for await (const message of subscription) {
        if (this.#disposed || !definition.handle.active) continue;

        try {
          const requestData = this.#deserializeData(message.data);
          this.#hub.log("debug", `Received service request for ${this.#subject}:`, requestData);
          
          let responseData;
          try {
            responseData = await definition.handler(requestData, message);
          } catch (handlerError) {
            this.#hub.log("error", `Handler error: ${this.#subject}`, handlerError);
            responseData = { 
              error: true, 
              message: handlerError.message || 'Service handler error' 
            };
          }
          
          if (message.reply) {
            const responseMessage = this.#serializeData(responseData);
            connection.publish(message.reply, responseMessage);
            this.#hub.log("debug", `Sent service response for ${this.#subject}:`, responseData);
          }
          
        } catch (error) {
          this.#hub.log("error", `Request error: ${this.#subject}`, error);
        }
      }
    } catch (error) {
      if (!this.#disposed && this.#hub.healthCheckActive && definition.handle.active) {
        this.#hub.log("error", `Service error: ${this.#subject}`, error);
      }
    }
  }

  // Helper methods
  #generateSubscriptionKey(options) {
    const keyParts = [
      options.queue || "",
      options.max || "",
      JSON.stringify(options.headers || {})
    ];
    return keyParts.join("_");
  }

  #serializeData(data) {
    return this.#hub.serializeData(data);
  }

  #deserializeData(uint8Array) {
    return this.#hub.deserializeData(uint8Array);
  }

  #isDuplicateMessage(message) {
    if (!this.#lastPublishedMessage) return false;
    
    if (message.length !== this.#lastPublishedMessage.length) return false;
    
    return message.every((byte, index) => byte === this.#lastPublishedMessage[index]);
  }

  /**
   * Cleans up subscriptions and resources
   */
  dispose() {
    this.#disposed = true;
    this.#clearValueTrackingRetry();

    for (const subscription of [this.#valueSubscription]) {
      if (!subscription) continue;
      try {
        subscription.unsubscribe();
      } catch (error) {
        this.#hub.log("warn", "Cleanup failed", error);
      }
    }

    if (this.#serviceDefinition) {
      try {
        this.#serviceDefinition.handle.unsubscribe();
      } catch (error) {
        this.#hub.log("warn", `Cleanup failed: ${this.#subject}_service`, error);
      }
      this.#serviceDefinition = null;
    }

    for (const [key, definition] of this.#subscriptionDefinitions) {
      try {
        definition.handle.unsubscribe();
      } catch (error) {
        this.#hub.log("warn", `Cleanup failed: ${key}`, error);
      }
    }

    this.#subscriptionDefinitions.clear();
    this.#resetState();
  }

  // Reset variable state
  #resetState() {
    this.#lastPublishedMessage = null;
    this.#latestValue = null;
    this.#hasReceivedValue = false;
    this.#valueSubscription = null;
    this.#valueTrackingConnection = null;
  }
}

export default KinopioHub;
