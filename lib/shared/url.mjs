// URL normalization and matching helpers shared by the hub client and the
// leaf runtime. Pure — safe for browser bundles.

export const CLIENT_CONNECT_PROTOCOLS = new Set(["ws:", "wss:"]);
export const DISCOVERY_MANIFEST_PROTOCOLS = new Set(["http:", "https:"]);
export const DEFAULT_AUTO_LEAF_BACKBONE_PORT = 17_222;

// Single source for well-known default ports (previously three hand-kept copies).
const TLS_LIKE_PROTOCOLS = new Set(["wss:", "https:", "tls:"]);
const LEAFNODE_PROTOCOLS = new Set(["nats-leaf:", "tls:"]);

export function uniqueServers(servers) {
  return [...new Set(servers)];
}

/**
 * Reduce a server URL (or bare host:port) to a comparable `host:port` identity.
 */
export function normalizeServerIdentity(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname) {
      const port = parsed.port || (TLS_LIKE_PROTOCOLS.has(parsed.protocol) ? "443" : "80");
      return `${parsed.hostname}:${port}`;
    }
  } catch {
    // Fall back to the client-reported host:port form below.
  }

  return trimmed
    .replace(/^[a-z][a-z\d+.-]*:\/\//iu, "")
    .split(/[/?#]/u)[0];
}

export function serversMatch(left, right) {
  const leftIdentity = normalizeServerIdentity(left);
  const rightIdentity = normalizeServerIdentity(right);
  return Boolean(leftIdentity && rightIdentity && leftIdentity === rightIdentity);
}

/**
 * Map a ws/wss client URL to the default auto-leaf backbone remote on the
 * same host (port 17222; tls:// for wss origins, nats:// otherwise).
 */
export function deriveDefaultBackboneServer(clientServer) {
  if (typeof clientServer !== "string" || clientServer.trim() === "") {
    return null;
  }

  try {
    const parsed = new URL(clientServer.trim());
    if (!CLIENT_CONNECT_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) {
      return null;
    }

    const protocol = parsed.protocol === "wss:" ? "tls:" : "nats:";
    const hostname = parsed.hostname.includes(":") && !parsed.hostname.startsWith("[")
      ? `[${parsed.hostname}]`
      : parsed.hostname;
    return `${protocol}//${hostname}:${DEFAULT_AUTO_LEAF_BACKBONE_PORT}`;
  } catch {
    return null;
  }
}

export function normalizeClientConnectServer(value, label = "server") {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty ws:// or wss:// URL string`);
  }

  const normalized = value.trim();
  let parsed;

  try {
    parsed = new URL(normalized);
  } catch {
    throw new TypeError(`${label} must be a valid ws:// or wss:// URL string`);
  }

  if (!CLIENT_CONNECT_PROTOCOLS.has(parsed.protocol)) {
    throw new TypeError(
      `Unsupported KinopioHub server URL protocol "${parsed.protocol}" in ${label}. KinopioHub client connections only support ws:// or wss:// URLs.`,
    );
  }

  return normalized;
}

export function normalizeDiscoveryEndpointUrl(value, label = "discovery manifest URL") {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty http:// or https:// URL string`);
  }

  const normalized = value.trim();
  let parsed;

  try {
    parsed = new URL(normalized);
  } catch {
    throw new TypeError(`${label} must be a valid http:// or https:// URL string`);
  }

  if (!DISCOVERY_MANIFEST_PROTOCOLS.has(parsed.protocol)) {
    throw new TypeError(`${label} must use http:// or https://`);
  }

  return normalized;
}

/**
 * Resolve the TCP endpoint to probe for a backbone remote URL.
 * Defaults: ws 80, wss 443, nats-leaf/tls 7422, anything else 4222.
 */
export function resolveBackboneProbeTarget(url) {
  const parsed = new URL(url);
  let port = parsed.port ? Number(parsed.port) : 4_222;
  if (!parsed.port && parsed.protocol === "ws:") {
    port = 80;
  } else if (!parsed.port && parsed.protocol === "wss:") {
    port = 443;
  } else if (!parsed.port && LEAFNODE_PROTOCOLS.has(parsed.protocol)) {
    port = 7_422;
  }

  return {
    host: parsed.hostname,
    port,
  };
}

/**
 * Port carried by a URL, falling back to protocol defaults for ws/wss/http/https.
 * Throws on syntactically invalid URLs (callers pass already-built URLs).
 */
export function readPortFromUrl(url) {
  if (typeof url !== "string" || url.trim() === "") {
    return null;
  }

  const parsed = new URL(url);
  const fallbackPort =
    parsed.protocol === "https:" || parsed.protocol === "wss:" ? 443
    : parsed.protocol === "http:" || parsed.protocol === "ws:" ? 80
    : null;

  return parsed.port ? Number(parsed.port) : fallbackPort;
}

export function readProtocolNameFromUrl(url, fallback = "") {
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
