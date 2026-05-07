export const DEFAULT_LEADER_MISSING_GRACE_MS = 10_000;
export const DEFAULT_COORDINATION_HEARTBEAT_MS = 1_000;
export const DEFAULT_LEADER_LEASE_MS = 4_000;
export const DEFAULT_DISCOVERY_SETTLE_MS = 1_250;
export const DEFAULT_BACKBONE_PROBE_INTERVAL_MS = 5_000;
export const DEFAULT_DISCOVERY_QUERY_INTERVAL_MS = 3_000;
export const PREEMPTION_THRESHOLD_MS = 50;
export const PREEMPTION_CONFIRMATION_CYCLES = 3;

export function normalizeFiniteRtt(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalizeEpoch(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function normalizeLeaseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function makeLeaseExpiresAt(now = Date.now(), leaseMs = DEFAULT_LEADER_LEASE_MS) {
  return new Date(now + leaseMs).toISOString();
}

export function isLeaseActive(leaseExpiresAt, now = Date.now()) {
  const leaseTimestamp = normalizeLeaseTimestamp(leaseExpiresAt);
  return leaseTimestamp !== null && leaseTimestamp > now;
}

export function compareCandidatePriority(left, right) {
  const leftRtt = normalizeFiniteRtt(left?.backboneRttMs);
  const rightRtt = normalizeFiniteRtt(right?.backboneRttMs);

  if (leftRtt !== null && rightRtt === null) return -1;
  if (leftRtt === null && rightRtt !== null) return 1;

  if (leftRtt !== null && rightRtt !== null && leftRtt !== rightRtt) {
    return leftRtt - rightRtt;
  }

  return String(left?.nodeId || "").localeCompare(String(right?.nodeId || ""));
}

export function compareLeaderRecords(left, right) {
  const leftEpoch = normalizeEpoch(left?.leaderEpoch);
  const rightEpoch = normalizeEpoch(right?.leaderEpoch);

  if (leftEpoch !== rightEpoch) {
    return rightEpoch - leftEpoch;
  }

  return compareCandidatePriority(left, right);
}

export function chooseElectionWinner(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  return [...candidates].sort(compareCandidatePriority)[0] ?? null;
}

export function chooseBestLeader(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  return [...candidates].sort(compareLeaderRecords)[0] ?? null;
}

export function shouldAttemptPreemption(candidateRttMs, leaderRttMs, thresholdMs = PREEMPTION_THRESHOLD_MS) {
  const candidateRtt = normalizeFiniteRtt(candidateRttMs);
  const leaderRtt = normalizeFiniteRtt(leaderRttMs);
  if (candidateRtt === null || leaderRtt === null) {
    return false;
  }

  return leaderRtt - candidateRtt >= thresholdMs;
}
