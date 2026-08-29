import { normalizeBackboneServerUrl } from "./runtime.mjs";
import {
  assertCompatibleBackboneServers,
  chooseLanAddress,
  resolveStableNodeId,
  validateAutoLeafOptions,
} from "./config.mjs";
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
  makeLeaseExpiresAt,
  normalizeEpoch,
  normalizeFiniteRtt,
  shouldAttemptPreemption,
} from "../shared/election.mjs";
import {
  DEFAULT_DISCOVERY_MANIFEST_TTL_MS,
  createPeerRecordFromManifest,
  createPeerRecordFromPayload,
  isPeerRecordFresh as isRecordFresh,
  mergePeerRecords,
  prunePeerRecordStore as pruneRecordStore,
  rememberPeerRecord,
  toPublicManifest,
} from "../shared/manifest.mjs";
import { assertNodeRuntime, isPlainObject, safeParseJson, toErrorMessage } from "../shared/assert.mjs";
import {
  buildMdnsAnnouncementPacket,
  buildMdnsQueryPacket,
  extractKinopioLeafManifests,
  parseMdnsPacket,
} from "./mdns.mjs";
import { acquireSharedMulticastBus } from "./multicast.mjs";
import { measureBackboneRtt } from "./probes.mjs";
import { startLeafNode } from "./leaf-node.mjs";

const AUTO_AGENT_TICK_MS = 250;
const AUTO_LEAF_RETRY_DELAY_MS = 2_000;
const AUTO_COORDINATION_GROUP = "239.255.42.99";
const AUTO_COORDINATION_PORT = 45_217;
const AUTO_MDNS_GROUP = "224.0.0.251";
const AUTO_MDNS_PORT = 5_353;
const AUTO_MDNS_TTL_SECONDS = Math.max(1, Math.ceil(DEFAULT_LEADER_LEASE_MS / 1_000));
const AUTO_PROTOCOL_VERSION = 1;

function mapAutoLeafRole(stateName) {
  if (stateName === "leader") return "leader";
  if (stateName === "following-leader") return "follower";
  if (stateName === "stopped") return "stopped";
  return "candidate";
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
  const candidates = new Map();
  const selfRole = includeSelfAsCandidate ? "candidate" : mapAutoLeafRole(agent.stateName);
  if (selfRole === "candidate" || selfRole === "leader") {
    rememberPeerRecord(candidates, buildSelfPresenceRecord(agent, now, selfRole));
  }

  for (const store of [agent.peerRecords, agent.mdnsRecords]) {
    for (const record of store.values()) {
      if (!isRecordFresh(record, now)) continue;
      if (record.candidateRole === "candidate" || record.isLeader) {
        rememberPeerRecord(candidates, record);
      }
    }
  }

  return [...candidates.values()];
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
  const nextLeaderEpoch = Math.max(
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

    agent.localLeaderEpoch = nextLeaderEpoch;
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

async function cleanupAutoLeafAgent(agent, coordinationBus, mdnsBus) {
  if (agent) {
    agent.stopped = true;
    agent.stateName = "stopped";
    clearInterval(agent.heartbeatTimer);
    clearInterval(agent.mdnsQueryTimer);
    clearInterval(agent.probeTimer);
    clearInterval(agent.evaluationTimer);
    agent.coordinationUnsubscribe?.();
    agent.mdnsUnsubscribe?.();

    await agent.leafStartPromise?.catch(() => null);
    await agent.evaluationPromise?.catch(() => null);
    await agent.backboneProbePromise?.catch(() => null);
    await stopLocalLeaf(agent);
  }

  await Promise.all([
    coordinationBus?.release(),
    mdnsBus?.release(),
  ]);
}

export async function enableAutoLeaf(options) {
  assertNodeRuntime("enableAutoLeaf()");
  validateAutoLeafOptions(options);

  const normalizedBackboneServers = (options.backboneServers || []).map(normalizeBackboneServerUrl);
  assertCompatibleBackboneServers(normalizedBackboneServers);
  const leaderMissingGraceMs = options.leaderMissingGraceMs || DEFAULT_LEADER_MISSING_GRACE_MS;
  const lanBindAddress = chooseLanAddress(options.lanBindAddress);
  const advertisedHostname = options.advertisedHostname || lanBindAddress;
  const { nodeId } = await resolveStableNodeId(options.cacheDir, options.nodeId);
  const coordinationBus = await acquireSharedMulticastBus("kinopio-auto-leaf-coordination", {
    groupAddress: AUTO_COORDINATION_GROUP,
    port: AUTO_COORDINATION_PORT,
  });
  let mdnsBus = null;
  let agent = null;

  try {
    mdnsBus = await acquireSharedMulticastBus("kinopio-auto-leaf-mdns", {
      groupAddress: AUTO_MDNS_GROUP,
      port: AUTO_MDNS_PORT,
      optional: true,
    });

    agent = {
    options,
    nodeId,
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
          await cleanupAutoLeafAgent(agent, coordinationBus, mdnsBus);
          updateCurrentLeader(agent, null);
        })();

        return await agent.stopPromise;
      },
    };
  } catch (error) {
    await cleanupAutoLeafAgent(agent, coordinationBus, mdnsBus).catch(() => null);
    throw error;
  }
}
