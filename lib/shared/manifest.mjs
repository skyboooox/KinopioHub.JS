// Single source of truth for the kinopio leader-manifest schema and the peer
// record utilities built on it. Previously the schema was hand-maintained in
// three places (hub-side validator, leaf-side payload parser, leaf-side
// manifest builders); every field addition had to be repeated. Pure — safe
// for browser bundles.

import { isPlainObject, isPositiveFiniteNumber, normalizeStringArray } from "./assert.mjs";
import {
  DEFAULT_LEADER_LEASE_MS,
  isLeaseActive,
  normalizeEpoch,
  normalizeFiniteRtt,
} from "./election.mjs";
import { normalizeClientConnectServer, normalizeDiscoveryEndpointUrl } from "./url.mjs";

export const WELL_KNOWN_MANIFEST_PATH = "/.well-known/kinopio-leader.json";
export const DEFAULT_DISCOVERY_MANIFEST_TTL_MS = 5_000;
export const PEER_RECORD_STALE_MS = DEFAULT_LEADER_LEASE_MS * 2;

export const DISCOVERY_BRIDGE_STATES = new Set(["connecting", "connected", "disconnected", "error"]);
const CANDIDATE_ROLES = new Set(["leader", "follower", "candidate", "stopped"]);

function normalizeCandidateRole(value, fallback) {
  return CANDIDATE_ROLES.has(value) ? value : fallback;
}

/**
 * Strict consumer-side validation used by the hub before switching to a local
 * leaf: requires a usable websocket URL and an unexpired manifest, and
 * normalizes URL fields (throwing TypeError on malformed URLs).
 * Returns null when the manifest is unusable.
 */
export function normalizeDiscoveryManifest(manifest) {
  if (!isPlainObject(manifest)) {
    return null;
  }

  const rawWebsocketUrl =
    typeof manifest.websocketUrl === "string" && manifest.websocketUrl.trim() !== ""
      ? manifest.websocketUrl
      : typeof manifest.wssUrl === "string" && manifest.wssUrl.trim() !== ""
        ? manifest.wssUrl
        : null;
  const expiresAtCandidate =
    typeof manifest.expiresAt === "string" && manifest.expiresAt.trim() !== ""
      ? manifest.expiresAt
      : typeof manifest.leaseExpiresAt === "string" && manifest.leaseExpiresAt.trim() !== ""
        ? manifest.leaseExpiresAt
        : null;
  const expiresAtTimestamp = expiresAtCandidate ? Date.parse(expiresAtCandidate) : Number.NaN;
  if (!rawWebsocketUrl || !Number.isFinite(expiresAtTimestamp) || expiresAtTimestamp <= Date.now()) {
    return null;
  }

  const websocketUrl = normalizeClientConnectServer(rawWebsocketUrl, "discovery manifest websocketUrl");
  const discoveryUrl =
    typeof manifest.discoveryUrl === "string" && manifest.discoveryUrl.trim() !== ""
      ? normalizeDiscoveryEndpointUrl(manifest.discoveryUrl, "discovery manifest discoveryUrl")
      : undefined;

  return {
    version: typeof manifest.version === "string" ? manifest.version : "1",
    expiresAt: new Date(expiresAtTimestamp).toISOString(),
    leaderEpoch: normalizeEpoch(manifest.leaderEpoch),
    advertisedHostname: typeof manifest.advertisedHostname === "string" ? manifest.advertisedHostname : "",
    websocketUrl,
    wssUrl: websocketUrl,
    fallbackServers: normalizeStringArray(manifest.fallbackServers),
    bridgeState: DISCOVERY_BRIDGE_STATES.has(manifest.bridgeState) ? manifest.bridgeState : undefined,
    backboneRttMs: isPositiveFiniteNumber(manifest.backboneRttMs) || manifest.backboneRttMs === 0
      ? manifest.backboneRttMs
      : null,
    discoveryUrl,
    leaseExpiresAt:
      typeof manifest.leaseExpiresAt === "string" && manifest.leaseExpiresAt.trim() !== ""
        ? manifest.leaseExpiresAt
        : undefined,
    nodeId:
      typeof manifest.nodeId === "string" && manifest.nodeId.trim() !== ""
        ? manifest.nodeId
        : undefined,
    discoveryNamespace:
      typeof manifest.discoveryNamespace === "string" && manifest.discoveryNamespace.trim() !== ""
        ? manifest.discoveryNamespace
        : undefined,
    isLeader: manifest.isLeader === undefined ? undefined : Boolean(manifest.isLeader),
    candidateRole: normalizeCandidateRole(manifest.candidateRole, undefined),
  };
}

export function cloneManifest(manifest) {
  if (!isPlainObject(manifest)) {
    return null;
  }

  const clone = { ...manifest };
  if (Array.isArray(manifest.fallbackServers)) {
    clone.fallbackServers = [...manifest.fallbackServers];
  }
  return clone;
}

/**
 * Lenient producer/peer-side parser used by the auto-leaf agent for
 * coordination heartbeats. Accepts expired manifests (freshness is judged
 * separately via isPeerRecordFresh); requires nodeId + discoveryNamespace.
 */
export function createPeerRecordFromPayload(payload, receivedAt = Date.now()) {
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
    candidateRole: normalizeCandidateRole(
      payload.candidateRole,
      payload.isLeader ? "leader" : "candidate",
    ),
    receivedAt,
  };
}

export function createPeerRecordFromManifest(manifest, receivedAt = Date.now()) {
  return createPeerRecordFromPayload(
    {
      ...manifest,
      isLeader: manifest?.isLeader ?? true,
      candidateRole: manifest?.candidateRole || "leader",
    },
    receivedAt,
  );
}

/**
 * Merge two records for the same node, preferring the newer one field by
 * field. The leader epoch comes from the preferred (newest) record — taking
 * Math.max across both let a stale record's inflated epoch stick forever.
 */
export function mergePeerRecords(existing, next) {
  if (!existing) return next;
  if (!next) return existing;

  const preferred = (next.receivedAt || 0) >= (existing.receivedAt || 0) ? next : existing;
  const fallback = preferred === next ? existing : next;
  const preferredFallbackServers = normalizeStringArray(preferred.fallbackServers);
  const fallbackFallbackServers = normalizeStringArray(fallback.fallbackServers);

  return {
    version: preferred.version || fallback.version || "1",
    expiresAt: preferred.expiresAt || fallback.expiresAt || "",
    leaderEpoch: normalizeEpoch(preferred.leaderEpoch),
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

export function toPublicManifest(record, ttlMs = DEFAULT_DISCOVERY_MANIFEST_TTL_MS) {
  if (!record) {
    return null;
  }

  return cloneManifest({
    version: record.version || "1",
    expiresAt: record.expiresAt || record.leaseExpiresAt || new Date(Date.now() + ttlMs).toISOString(),
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

export function rememberPeerRecord(store, record) {
  if (!record?.nodeId) return;
  const existing = store.get(record.nodeId);
  store.set(record.nodeId, mergePeerRecords(existing, record));
}

export function isPeerRecordFresh(record, now = Date.now(), staleMs = PEER_RECORD_STALE_MS) {
  if (!record) return false;
  if ((now - (record.receivedAt || 0)) > staleMs) {
    return false;
  }

  if (record.isLeader && record.leaseExpiresAt) {
    return isLeaseActive(record.leaseExpiresAt, now);
  }

  return true;
}

export function prunePeerRecordStore(store, now = Date.now(), staleMs = PEER_RECORD_STALE_MS) {
  for (const [nodeId, record] of store.entries()) {
    if (!isPeerRecordFresh(record, now, staleMs)) {
      store.delete(nodeId);
    }
  }
}
