// Option resolution for KinopioHub. All defaults and acceptance rules are
// part of the public contract and must match the documented 2.x behavior.

import { isPlainObject, isPositiveFiniteNumber } from "../shared/assert.mjs";
import { normalizeClientConnectServer, normalizeDiscoveryEndpointUrl } from "../shared/url.mjs";
import { WELL_KNOWN_MANIFEST_PATH } from "../shared/manifest.mjs";

export const DEFAULT_SERVERS = ["wss://demo.nats.io:8443", "wss://demo.nats.io:4443"];
export const SERVER_SELECTION_MODES = new Set(["ordered", "random", "latency"]);
export const DEFAULT_SERVER_SELECTION_MODE = "latency";
export const DEFAULT_DISCOVERY_CACHE_TTL_MS = 5_000;
export const DEFAULT_LOCAL_SWITCH_TIMEOUT_MS = 1_500;

export function resolveHubOptions(options = {}) {
  const resolvedDiscovery = options.discovery === undefined
    ? { enabled: true }
    : options.discovery;
  const resolvedAutoLeaf = options.autoLeaf === undefined
    ? { enabled: true, discoveryNamespace: "local", webSocketTls: false }
    : options.autoLeaf;

  return {
    debug: false,
    servers: [...DEFAULT_SERVERS],
    noEcho: false,
    // Left undefined so resolveServerSelectionMode() can honor the documented
    // legacy `noRandomize` alias when the mode was not set explicitly (2.1.x
    // pre-filled the default here, which made the alias branch unreachable).
    serverSelectionMode: undefined,
    noRandomize: undefined,
    maxReconnectAttempts: -1,
    waitOnFirstConnect: true,
    reconnectTimeWait: 500,
    pingInterval: 3000,
    maxPingOut: 3,
    timeout: 3000,
    autoConnect: true,
    autoRetry: true,
    retryDelay: 1000,
    maxRetryDelay: 30000,
    retryBackoffFactor: 1.5,
    jsonReplacer: undefined,
    jsonReviver: undefined,
    codec: undefined,
    ...options,
    discovery: resolvedDiscovery,
    autoLeaf: resolvedAutoLeaf,
  };
}

/**
 * Options forwarded to wsconnect(). Strips everything the hub itself
 * consumes, plus historical no-ops (`reconnectTimeout`, `healthReport`) that
 * were never @nats-io/nats-core options.
 */
export function createBaseConnectOptions(hubOptions) {
  const {
    serverSelectionMode,
    autoConnect,
    autoRetry,
    retryDelay,
    maxRetryDelay,
    retryBackoffFactor,
    healthReport,
    reconnectTimeout,
    discovery,
    autoLeaf,
    codec,
    jsonReplacer,
    jsonReviver,
    servers,
    ...connectOptions
  } = hubOptions;

  return connectOptions;
}

export function resolveServerSelectionMode(hubOptions) {
  const configuredMode = hubOptions.serverSelectionMode;
  if (SERVER_SELECTION_MODES.has(configuredMode)) {
    return configuredMode;
  }

  if (typeof hubOptions.noRandomize === "boolean") {
    return hubOptions.noRandomize ? "ordered" : "random";
  }

  return DEFAULT_SERVER_SELECTION_MODE;
}

export function normalizeServerCandidates(servers) {
  const inputServers =
    servers == null
      ? []
      : Array.isArray(servers)
        ? servers
        : [servers];
  const candidates = inputServers.map((server, index) =>
    normalizeClientConnectServer(server, `options.servers[${index}]`),
  );

  return candidates.length > 0 ? candidates : [...DEFAULT_SERVERS];
}

/**
 * Resolve discovery options against the current environment.
 * `autoLeafManifestUrl` is the manifest URL advertised by the auto-started
 * local leaf (if any); `requireBackbone` defaults to true only for that URL.
 * Returns null when discovery is disabled or no manifest URL can be derived.
 */
export function resolveDiscoveryOptions(hubOptions, { isBrowser, autoLeafManifestUrl }) {
  const discovery = hubOptions.discovery;
  if (discovery === false) {
    return null;
  }

  const discoveryOptions = isPlainObject(discovery) ? discovery : {};
  if (discoveryOptions.enabled === false) {
    return null;
  }

  let manifestUrl = null;

  if (typeof discoveryOptions.manifestUrl === "string" && discoveryOptions.manifestUrl.trim() !== "") {
    try {
      const baseUrl = isBrowser ? globalThis.window?.location?.href : undefined;
      manifestUrl = normalizeDiscoveryEndpointUrl(
        new URL(discoveryOptions.manifestUrl.trim(), baseUrl).toString(),
        "options.discovery.manifestUrl",
      );
    } catch {
      manifestUrl = null;
    }
  } else if (autoLeafManifestUrl) {
    manifestUrl = autoLeafManifestUrl;
  } else if (isBrowser) {
    try {
      manifestUrl = normalizeDiscoveryEndpointUrl(
        new URL(WELL_KNOWN_MANIFEST_PATH, globalThis.window?.location?.href).toString(),
        "default discovery manifest URL",
      );
    } catch {
      manifestUrl = null;
    }
  }

  if (!manifestUrl) {
    return null;
  }

  return {
    manifestUrl,
    backgroundLocalProbe: discoveryOptions.backgroundLocalProbe !== false,
    requireBackbone: discoveryOptions.requireBackbone === undefined
      ? manifestUrl === autoLeafManifestUrl
      : discoveryOptions.requireBackbone !== false,
    localSwitchTimeoutMs: isPositiveFiniteNumber(discoveryOptions.localSwitchTimeoutMs)
      ? Math.floor(discoveryOptions.localSwitchTimeoutMs)
      : DEFAULT_LOCAL_SWITCH_TIMEOUT_MS,
    cacheTtlMs: isPositiveFiniteNumber(discoveryOptions.cacheTtlMs)
      ? Math.floor(discoveryOptions.cacheTtlMs)
      : DEFAULT_DISCOVERY_CACHE_TTL_MS,
  };
}
