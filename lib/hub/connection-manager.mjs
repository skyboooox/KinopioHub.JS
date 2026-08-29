// Connection lifecycle for KinopioHub: candidate planning (ordered / random /
// latency), the single establish path shared by initial connects and hot
// switches, retry with jittered backoff, health monitoring, and background
// latency re-probing.
//
// Design notes:
// - 2.1.x had two hand-duplicated connect sequences (#doConnect and
//   #switchActiveConnection) that had already diverged; both are now
//   #establish().
// - Every timer/loop is tied to an epoch + AbortController. reconnect() and
//   dispose() bump the epoch, so no stale loop can strand a caller — the
//   2.1.x #cleanup() cleared a global timer set, which silently killed the
//   retry-backoff and connected()-timeout timers and left callers hanging
//   forever.
// - Connection verification is a flush() round trip; 2.1.x published to a
//   hardcoded `_test.connection` subject.

import { wsconnect } from "@nats-io/nats-core";

import { sleep } from "../shared/assert.mjs";
import { serversMatch, uniqueServers } from "../shared/url.mjs";
import { KINOPIO_DISPOSE_EVENT, KINOPIO_STATE_EVENT } from "./constants.mjs";
import {
  createBaseConnectOptions,
  normalizeServerCandidates,
  resolveServerSelectionMode,
} from "./options.mjs";

const LATENCY_REPROBE_INTERVAL_MS = 10 * 60 * 1000;
const LATENCY_SWITCH_THRESHOLD_MS = 30;
const DEFAULT_CONNECTED_WAIT_TIMEOUT_MS = 10_000;

export class ConnectionManager {
  #options;
  #log;
  #events;
  #rebindAll;
  #onEstablished;
  #onServerChanged;

  #state = "disconnected";
  #activeConnection = null;
  #activePlan = null;
  #connectPromise = null;
  #switchLock = Promise.resolve();
  #switching = false;
  #retryAttempt = 0;
  #currentRetryDelay = 0;
  #latencyProbeTimer = null;
  #healthCheckActive = false;
  #epoch = 0;
  #abortController = new AbortController();
  #disposed = false;

  /**
   * @param {object} deps
   * @param {object} deps.options - resolved hub options
   * @param {Function} deps.log
   * @param {import("../shared/emitter.mjs").Emitter} deps.events
   * @param {(connection: object) => Promise<void>} deps.rebindAll - rebuild
   *   subscriptions/services/value tracking on the candidate connection
   * @param {(plan: object, connection: object) => Promise<void>} [deps.onEstablished]
   *   - runs after a connection is promoted and the state is settled
   * @param {(plan: object, connection: object) => Promise<void>} [deps.onServerChanged]
   *   - runs when the underlying client reconnected to a different server
   */
  constructor({ options, log, events, rebindAll, onEstablished, onServerChanged }) {
    this.#options = options;
    this.#log = log;
    this.#events = events;
    this.#rebindAll = rebindAll;
    this.#onEstablished = onEstablished ?? null;
    this.#onServerChanged = onServerChanged ?? null;
  }

  get state() {
    return this.#state;
  }

  get isConnected() {
    return this.#state === "connected";
  }

  get connection() {
    return this.#activeConnection;
  }

  get activePlan() {
    return this.#activePlan;
  }

  get switching() {
    return this.#switching;
  }

  get healthCheckActive() {
    return this.#healthCheckActive;
  }

  get disposed() {
    return this.#disposed;
  }

  #setState(newState) {
    if (this.#state === newState) return;

    const oldState = this.#state;
    this.#state = newState;
    this.#log("info", `State: ${oldState} -> ${newState}`);
    this.#events.emit(KINOPIO_STATE_EVENT, newState);
  }

  async connect() {
    if (this.#disposed) {
      throw new Error("KinopioHub disposed");
    }

    if (this.#state === "connected") {
      this.#log("debug", "Connection exists");
      return;
    }

    if (this.#connectPromise) {
      this.#log("debug", "Connecting in progress");
      return this.#connectPromise;
    }

    if (this.#state === "connecting") {
      // The underlying client is reconnecting on its own (health-check state).
      // 2.1.x returned immediately here, resolving connect() without a
      // connection; wait for an actual settle instead.
      return this.waitForConnected(null);
    }

    const runPromise = this.#run();
    this.#connectPromise = runPromise;

    try {
      await runPromise;
    } catch (error) {
      if (this.#options.autoRetry === false || this.#disposed || this.#state === "error") {
        // With autoRetry enabled, #run only throws on aborts and on
        // unrecoverable configuration errors (state set to "error") — the
        // latter must reach the caller instead of being retried or swallowed.
        throw error;
      }
      // Aborted by a concurrent reconnect(): follow the replacement attempt.
      return this.waitForConnected(null);
    } finally {
      if (this.#connectPromise === runPromise) {
        this.#connectPromise = null;
      }
    }
  }

  async #run() {
    const epoch = this.#epoch;
    const signal = this.#abortController.signal;

    this.#setState("connecting");

    let sourceCandidates;
    try {
      // Malformed server URLs are unrecoverable — fail fast instead of
      // retrying them forever (2.1.x looped on the TypeError).
      sourceCandidates = normalizeServerCandidates(this.#options.servers);
    } catch (error) {
      this.#setState("error");
      throw error;
    }

    while (!signal.aborted && this.#epoch === epoch) {
      this.#retryAttempt++;

      try {
        const plan = await this.#createConnectionPlan(sourceCandidates);
        this.#log(
          "info",
          `Connecting to NATS (attempt ${this.#retryAttempt}) using ${plan.mode} mode`,
          plan.orderedCandidates,
        );

        await this.#runExclusive(() => this.#establish(plan, { previousConnection: this.#activeConnection }));
        this.#setState("connected");
        await this.#afterEstablished(plan, { initial: true });

        this.#retryAttempt = 0;
        this.#currentRetryDelay = 0;
        this.#log("info", "NATS connected successfully");
        return;
      } catch (error) {
        if (signal.aborted || this.#epoch !== epoch) {
          throw new Error("Connection attempt aborted");
        }

        this.#log("error", `Connection attempt ${this.#retryAttempt} failed:`, error.message);

        if (this.#options.autoRetry === false) {
          this.#setState("error");
          throw error;
        }

        if (this.#retryAttempt === 1) {
          this.#currentRetryDelay = this.#options.retryDelay;
        } else {
          this.#currentRetryDelay = Math.min(
            this.#currentRetryDelay * this.#options.retryBackoffFactor,
            this.#options.maxRetryDelay,
          );
        }
        const jitter = Math.floor(Math.random() * this.#currentRetryDelay);
        this.#log("info", `Will retry in ${jitter}ms...`);
        await sleep(jitter, { signal });
      }
    }

    throw new Error("Connection attempt aborted");
  }

  /**
   * Open a connection for `plan`, rebind all registered state onto it,
   * verify it, and promote it — the one path shared by initial connects,
   * latency hot switches, and discovery switches.
   */
  async #establish(plan, { previousConnection = null, timeoutMs, expectedServer } = {}) {
    const connection = await this.#openConnection(
      plan,
      "candidate connection",
      timeoutMs ?? this.#options.timeout ?? 10_000,
    );

    try {
      await this.#rebindAll(connection);
      await connection.flush();

      plan.connectedServer = connection.getServer?.() ?? plan.orderedCandidates[0];
      if (expectedServer && !serversMatch(plan.connectedServer, expectedServer)) {
        throw new Error(
          `Expected discovery switch to connect ${expectedServer}, but the candidate connection settled on ${plan.connectedServer}`,
        );
      }

      this.#activeConnection = connection;
      this.#activePlan = plan;
      this.#startHealthCheck(connection);
      this.#scheduleLatencyProbeCycle();

      if (previousConnection && previousConnection !== connection) {
        await this.#closeConnection(previousConnection, "previous active connection after switch");
      }

      return connection;
    } catch (error) {
      await this.#closeConnection(connection, "candidate connection");
      throw error;
    }
  }

  async #afterEstablished(plan, context = { initial: false }) {
    try {
      await this.#onEstablished?.(plan, this.#activeConnection, context);
    } catch (error) {
      this.#log("warn", "Post-connect hook failed:", error);
    }
  }

  /** Hot switch onto `plan` (latency winner or discovered local leaf). */
  async switchTo(plan, { timeoutMs, expectedServer } = {}) {
    if (this.#disposed) {
      throw new Error("KinopioHub disposed");
    }

    const connection = await this.#runExclusive(() =>
      this.#establish(plan, {
        previousConnection: this.#activeConnection,
        timeoutMs,
        expectedServer,
      }),
    );
    await this.#afterEstablished(plan);
    return connection;
  }

  #runExclusive(task) {
    const run = this.#switchLock.then(
      async () => {
        this.#switching = true;
        try {
          return await task();
        } finally {
          this.#switching = false;
        }
      },
    );
    this.#switchLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #openConnection(plan, label, timeoutMs) {
    const connectOptions = {
      ...createBaseConnectOptions(this.#options),
      servers: plan.orderedCandidates,
      // Candidate order is controlled here; the client must preserve it for
      // both the initial connect and later reconnects.
      noRandomize: true,
    };

    const connectPromise = wsconnect(connectOptions);
    // A late failure after we time out must not become an unhandled rejection.
    connectPromise.catch(() => {});

    let timer = null;
    const winner = await Promise.race([
      connectPromise.then((connection) => ({ connection })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);

    if (winner.timedOut) {
      connectPromise
        .then((connection) => this.#closeConnection(connection, `${label} after timeout`))
        .catch(() => {});
      throw new Error("NATS connection timeout");
    }

    return winner.connection;
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

  // ---- planning -----------------------------------------------------------

  async #createConnectionPlan(sourceCandidates = normalizeServerCandidates(this.#options.servers)) {
    const mode = resolveServerSelectionMode(this.#options);
    let orderedCandidates = this.#orderConnectionCandidates(sourceCandidates, mode);
    let probeResults = [];
    let latencyProbeFailedAll = false;

    if (mode === "latency" && orderedCandidates.length > 1) {
      const probeSummary = await this.#probeLatencyCandidates(sourceCandidates);
      orderedCandidates = probeSummary.orderedCandidates;
      probeResults = probeSummary.probeResults;
      latencyProbeFailedAll = probeSummary.allFailed;

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
          probeResults.map((result) => ({
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
      latencyProbeFailedAll,
      probeResults,
    };
  }

  /** Public wrapper used by the discovery prober for remote fallbacks. */
  async createConnectionPlan() {
    return await this.#createConnectionPlan();
  }

  #orderConnectionCandidates(candidates, mode) {
    if (candidates.length <= 1) {
      return [...candidates];
    }

    if (mode === "random") {
      const shuffled = [...candidates];
      for (let index = shuffled.length - 1; index > 0; index--) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
      }
      return shuffled;
    }

    return [...candidates];
  }

  async #probeServerLatency(server, index) {
    let connection = null;

    try {
      connection = await wsconnect({
        ...createBaseConnectOptions(this.#options),
        servers: [server],
        noRandomize: true,
        reconnect: false,
        maxReconnectAttempts: 0,
        waitOnFirstConnect: false,
      });

      await connection.flush();
      const rtt = await connection.rtt();
      if (!Number.isFinite(rtt)) {
        throw new Error(`Invalid RTT result for ${server}`);
      }

      return { server, index, healthy: true, rtt, error: null };
    } catch (error) {
      return { server, index, healthy: false, rtt: Number.POSITIVE_INFINITY, error };
    } finally {
      await this.#closeConnection(connection, `latency probe for ${server}`);
    }
  }

  async #probeLatencyCandidates(candidates) {
    const probeResults = await Promise.all(
      candidates.map((server, index) => this.#probeServerLatency(server, index)),
    );

    const healthyResults = probeResults
      .filter((result) => result.healthy)
      .sort((left, right) => left.rtt - right.rtt || left.index - right.index);
    const failedResults = probeResults
      .filter((result) => !result.healthy)
      .sort((left, right) => left.index - right.index);
    const allFailed = healthyResults.length === 0;

    return {
      allFailed,
      probeResults,
      healthyResults,
      orderedCandidates: allFailed
        ? [...candidates]
        : [...healthyResults, ...failedResults].map((result) => result.server),
    };
  }

  // ---- background latency re-probe ---------------------------------------

  #supportsLatencyMonitoring(plan = this.#activePlan) {
    return plan?.mode === "latency" && plan?.sourceCandidates?.length > 1;
  }

  isUsingDiscoveryLocalConnection(plan = this.#activePlan) {
    if (!plan?.discoveryLocalServer || !this.#activeConnection) {
      return false;
    }

    const currentServer = this.#activeConnection.getServer?.() ?? plan.connectedServer ?? null;
    return serversMatch(currentServer, plan.discoveryLocalServer);
  }

  #clearLatencyProbeTimer() {
    if (!this.#latencyProbeTimer) return;
    clearTimeout(this.#latencyProbeTimer);
    this.#latencyProbeTimer = null;
  }

  #scheduleLatencyProbeCycle() {
    this.#clearLatencyProbeTimer();

    if (this.#disposed || !this.#supportsLatencyMonitoring() || !this.#activeConnection) {
      return;
    }

    const epoch = this.#epoch;
    this.#latencyProbeTimer = setTimeout(() => {
      this.#latencyProbeTimer = null;
      if (epoch !== this.#epoch) return;
      this.#runLatencyProbeCycle().catch((error) => {
        this.#log("error", "Latency re-probe cycle failed:", error);
      });
    }, LATENCY_REPROBE_INTERVAL_MS);
    this.#latencyProbeTimer.unref?.();
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

  async #maybeHotSwitchLatencyConnection() {
    const currentPlan = this.#activePlan;

    if (!this.#activeConnection || this.#state !== "connected" || !this.#supportsLatencyMonitoring(currentPlan)) {
      return false;
    }

    if (this.isUsingDiscoveryLocalConnection(currentPlan)) {
      this.#log("debug", "Skipping background latency hot switch while a discovered local leaf is active");
      return false;
    }

    const probeSummary = await this.#probeLatencyCandidates(currentPlan.sourceCandidates);
    if (probeSummary.allFailed) {
      this.#log("warn", "Background latency re-probe failed for every configured server; keeping the current connection");
      return false;
    }

    const bestHealthy = probeSummary.healthyResults[0];
    const currentServer =
      this.#activeConnection.getServer?.() ?? currentPlan.connectedServer ?? currentPlan.orderedCandidates[0];
    const currentHealthy =
      probeSummary.healthyResults.find((result) => result.server === currentServer) ?? null;

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
      latencyProbeFailedAll: false,
    };

    this.#log("info", "Hot switching to a lower-latency server", {
      from: currentServer,
      to: bestHealthy.server,
      currentRtt: currentHealthy?.rtt ?? null,
      nextRtt: bestHealthy.rtt,
      thresholdMs: LATENCY_SWITCH_THRESHOLD_MS,
    });

    await this.switchTo(nextPlan);
    return true;
  }

  // ---- health monitoring --------------------------------------------------

  #startHealthCheck(connection) {
    this.#healthCheckActive = true;
    const epoch = this.#epoch;

    this.#runHealthCheck(connection, epoch).catch((error) => {
      this.#log("error", "Health check failed:", error);
    });
  }

  async #runHealthCheck(connection, epoch) {
    try {
      for await (const status of connection.status()) {
        if (
          this.#disposed ||
          epoch !== this.#epoch ||
          !this.#healthCheckActive ||
          connection !== this.#activeConnection
        ) {
          break;
        }

        const stateMap = {
          reconnect: "connected",
          disconnect: "disconnected",
          reconnecting: "connecting",
        };

        const newState = stateMap[status.type];
        if (newState) {
          this.#setState(newState);
        }
        if (status.type === "reconnect") {
          await this.#handleActiveConnectionReconnect(connection);
        }
      }
    } catch (error) {
      if (
        !this.#disposed &&
        epoch === this.#epoch &&
        this.#healthCheckActive &&
        connection === this.#activeConnection
      ) {
        this.#log("error", "Health check error:", error);
        this.#setState("error");
      }
    }
  }

  async #handleActiveConnectionReconnect(connection) {
    const currentPlan = this.#activePlan;
    if (!currentPlan || currentPlan.discoveryLocalServer || connection !== this.#activeConnection) {
      return;
    }

    const connectedServer = connection.getServer?.();
    if (!connectedServer || serversMatch(currentPlan.connectedServer, connectedServer)) {
      return;
    }

    currentPlan.connectedServer = connectedServer;
    try {
      await this.#onServerChanged?.(currentPlan, connection);
    } catch (error) {
      this.#log("warn", "Reconnect hook failed:", error);
    }
  }

  // ---- waiting / lifecycle ------------------------------------------------

  /**
   * Resolve when connected. `timeoutMs = null` waits without a deadline.
   * Rejects on state "error", on timeout, or when the hub is disposed
   * (2.1.x left waiters hanging forever after dispose/reconnect).
   */
  waitForConnected(timeoutMs = DEFAULT_CONNECTED_WAIT_TIMEOUT_MS) {
    if (this.#state === "connected") {
      return Promise.resolve();
    }
    if (this.#disposed) {
      return Promise.reject(new Error("KinopioHub disposed"));
    }

    return new Promise((resolve, reject) => {
      let timer = null;
      let offState = null;
      let offDispose = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        offState?.();
        offDispose?.();
      };

      offState = this.#events.on(KINOPIO_STATE_EVENT, (state) => {
        if (state === "connected") {
          cleanup();
          resolve();
        } else if (state === "error") {
          cleanup();
          reject(new Error("Connection failed"));
        }
      });
      offDispose = this.#events.on(KINOPIO_DISPOSE_EVENT, () => {
        cleanup();
        reject(new Error("KinopioHub disposed"));
      });

      if (timeoutMs !== null && timeoutMs !== undefined) {
        timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Connection timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }

      // Settle races where the state changed while listeners were attached.
      if (this.#state === "connected") {
        cleanup();
        resolve();
      } else if (this.#state === "error") {
        cleanup();
        reject(new Error("Connection failed"));
      }
    });
  }

  async reconnect() {
    this.#log("info", "Reconnecting");

    try {
      await this.#cleanup();
      await this.connect();
    } catch (error) {
      this.#log("error", "Reconnect failed", error);
      this.#setState("error");
      throw error;
    }
  }

  /** Abort every loop/timer of the current epoch and close the connection. */
  async #cleanup() {
    this.#epoch += 1;
    this.#abortController.abort();
    this.#abortController = new AbortController();
    this.#healthCheckActive = false;
    this.#clearLatencyProbeTimer();
    this.#connectPromise = null;

    const activeConnection = this.#activeConnection;
    this.#activeConnection = null;
    this.#activePlan = null;

    await this.#closeConnection(activeConnection, "active connection during cleanup");
    this.#setState("disconnected");
  }

  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;

    await this.#cleanup();
    this.#events.emit(KINOPIO_DISPOSE_EVENT);
  }
}
