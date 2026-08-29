// Background local-leaf discovery: fetch the leader manifest from the
// well-known endpoint, hot-switch to a healthy local leaf, and fall back to
// the configured remote servers when the local leaf disappears.

import { normalizeDiscoveryManifest } from "../shared/manifest.mjs";
import { serversMatch, uniqueServers } from "../shared/url.mjs";
import { normalizeServerCandidates, resolveServerSelectionMode } from "./options.mjs";

export class DiscoveryProber {
  #manager;
  #log;
  #hubOptions;
  #getDiscoveryOptions;
  #probeTimer = null;
  #probePromise = null;
  #manifestCache = null;
  #manifestCacheExpiresAt = 0;
  #stopped = false;
  // Bumped on stop(): in-flight probe cycles from before a reconnect must
  // not apply their (stale) result to the replacement connection.
  #generation = 0;
  #fetchAbortController = null;

  /**
   * @param {object} deps
   * @param {import("./connection-manager.mjs").ConnectionManager} deps.manager
   * @param {Function} deps.log
   * @param {object} deps.hubOptions - resolved hub options
   * @param {() => object | null} deps.getDiscoveryOptions - resolves the
   *   current discovery options (manifest URL may follow the auto leaf)
   */
  constructor({ manager, log, hubOptions, getDiscoveryOptions }) {
    this.#manager = manager;
    this.#log = log;
    this.#hubOptions = hubOptions;
    this.#getDiscoveryOptions = getDiscoveryOptions;
  }

  clearManifestCache() {
    this.#manifestCache = null;
    this.#manifestCacheExpiresAt = 0;
  }

  #clearProbeTimer() {
    if (!this.#probeTimer) return;
    clearTimeout(this.#probeTimer);
    this.#probeTimer = null;
  }

  /** Kick off the discovery flow for the just-established connection. */
  async start({ immediateProbe = false } = {}) {
    if (this.#stopped) return;

    const discoveryOptions = this.#getDiscoveryOptions();
    if (!discoveryOptions || !this.#manager.connection) {
      return;
    }

    this.#clearProbeTimer();

    if (this.#manager.activePlan?.discoveryLocalServer) {
      if (discoveryOptions.backgroundLocalProbe) {
        this.scheduleProbeCycle(discoveryOptions.cacheTtlMs);
      }
      return;
    }

    if (discoveryOptions.backgroundLocalProbe) {
      this.scheduleProbeCycle(immediateProbe ? 0 : discoveryOptions.cacheTtlMs);
      return;
    }

    await this.runProbeCycle({ forceRefresh: true, reschedule: false });
  }

  scheduleProbeCycle(delayMs = 0) {
    this.#clearProbeTimer();

    if (this.#stopped) return;
    const discoveryOptions = this.#getDiscoveryOptions();
    if (!discoveryOptions?.backgroundLocalProbe || !this.#manager.connection || this.#manager.state !== "connected") {
      return;
    }

    this.#probeTimer = setTimeout(() => {
      this.#probeTimer = null;
      this.runProbeCycle().catch((error) => {
        this.#log("warn", "Background local leaf probe failed:", error);
      });
    }, Math.max(0, delayMs));
    this.#probeTimer.unref?.();
  }

  async runProbeCycle({ forceRefresh = false, reschedule = true } = {}) {
    if (this.#stopped) return false;

    const discoveryOptions = this.#getDiscoveryOptions();
    if (!discoveryOptions || !this.#manager.connection || this.#manager.state !== "connected") {
      return false;
    }

    if (this.#manager.switching) {
      return false;
    }

    if (this.#probePromise) {
      return await this.#probePromise;
    }

    const generation = this.#generation;
    const isCurrent = () => generation === this.#generation && !this.#stopped;

    const cyclePromise = (async () => {
      try {
        const manifest = await this.#fetchManifest(discoveryOptions, { forceRefresh });
        if (!isCurrent()) return false;
        return await this.#applyManifest(manifest, discoveryOptions, isCurrent);
      } catch (error) {
        this.#log("warn", "Background local leaf probe request failed; keeping the current connection", {
          manifestUrl: discoveryOptions.manifestUrl,
          error: error.message,
        });
        return false;
      } finally {
        if (reschedule && discoveryOptions.backgroundLocalProbe && this.#manager.connection && isCurrent()) {
          this.scheduleProbeCycle(discoveryOptions.cacheTtlMs);
        }
      }
    })().finally(() => {
      if (this.#probePromise === cyclePromise) {
        this.#probePromise = null;
      }
    });

    this.#probePromise = cyclePromise;
    return await cyclePromise;
  }

  async #fetchManifest(discoveryOptions, { forceRefresh = false } = {}) {
    if (!forceRefresh && this.#manifestCacheExpiresAt > Date.now()) {
      return this.#manifestCache;
    }

    if (typeof fetch !== "function") {
      throw new Error("fetch() is not available in this runtime");
    }

    let timeoutId = null;
    let signal;
    let controller = null;

    if (typeof AbortController !== "undefined") {
      controller = new AbortController();
      this.#fetchAbortController = controller;
      signal = controller.signal;
      timeoutId = setTimeout(() => {
        controller.abort(new Error("Discovery manifest fetch timed out"));
      }, discoveryOptions.localSwitchTimeoutMs);
      timeoutId.unref?.();
    }

    try {
      const response = await fetch(discoveryOptions.manifestUrl, {
        method: "GET",
        cache: "no-store",
        signal,
      });

      if (response.status === 204 || response.status === 404) {
        this.#manifestCache = null;
        this.#manifestCacheExpiresAt = Date.now() + discoveryOptions.cacheTtlMs;
        return null;
      }

      if (!response.ok) {
        throw new Error(`Discovery manifest fetch failed with HTTP ${response.status}`);
      }

      const manifest = normalizeDiscoveryManifest(await response.json());
      this.#manifestCache = manifest;
      this.#manifestCacheExpiresAt = Date.now() + discoveryOptions.cacheTtlMs;
      return manifest;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      // Identity-checked: a stale fetch settling late must not clear the
      // controller of a newer cycle (that would make stop() unable to abort it).
      if (controller && this.#fetchAbortController === controller) {
        this.#fetchAbortController = null;
      }
    }
  }

  #buildDiscoveryPreferredPlan(localServer, manifest, basePlan, manifestUrl) {
    const remoteSourceCandidates = uniqueServers(
      (basePlan?.sourceCandidates || normalizeServerCandidates(this.#hubOptions.servers))
        .filter((server) => !serversMatch(server, localServer)),
    );
    const remoteOrderedCandidates = uniqueServers(
      (basePlan?.orderedCandidates || remoteSourceCandidates)
        .filter((server) => !serversMatch(server, localServer)),
    );

    return {
      ...(basePlan || {}),
      mode: basePlan?.mode || resolveServerSelectionMode(this.#hubOptions),
      sourceCandidates: remoteSourceCandidates,
      orderedCandidates: uniqueServers([localServer, ...remoteOrderedCandidates]),
      createdAt: Date.now(),
      latencyProbeFailedAll: false,
      probeResults: basePlan?.probeResults || [],
      discoveryLocalServer: localServer,
      discoveryManifest: manifest,
      discoveryManifestUrl: manifestUrl,
      preferDiscoveryLocal: true,
    };
  }

  async #switchToRemoteFallback(discoveryOptions, reason, isCurrent) {
    const currentPlan = this.#manager.activePlan;
    const currentServer = this.#manager.connection?.getServer?.() ?? currentPlan?.connectedServer ?? null;

    if (!currentPlan?.discoveryLocalServer || !serversMatch(currentServer, currentPlan.discoveryLocalServer)) {
      return false;
    }

    const remotePlan = await this.#manager.createConnectionPlan();
    if (!isCurrent()) return false;
    this.#log("info", "Discovery probe is falling back to the configured remote servers", {
      reason,
      from: currentServer,
      manifestUrl: discoveryOptions.manifestUrl,
    });
    await this.#manager.switchTo(remotePlan, {
      timeoutMs: discoveryOptions.localSwitchTimeoutMs,
    });
    return true;
  }

  async #applyManifest(manifest, discoveryOptions, isCurrent) {
    const currentPlan = this.#manager.activePlan;
    const currentServer = this.#manager.connection?.getServer?.() ?? currentPlan?.connectedServer ?? null;

    if (!manifest) {
      return await this.#switchToRemoteFallback(discoveryOptions, "no usable local leader manifest", isCurrent);
    }

    const localServer = manifest.websocketUrl || manifest.wssUrl;
    if (!localServer) {
      return await this.#switchToRemoteFallback(discoveryOptions, "manifest did not expose a usable websocketUrl", isCurrent);
    }

    if (discoveryOptions.requireBackbone && manifest.bridgeState !== "connected") {
      return await this.#switchToRemoteFallback(
        discoveryOptions,
        `local leaf bridge is ${manifest.bridgeState || "unknown"}`,
        isCurrent,
      );
    }

    if (serversMatch(currentPlan?.discoveryLocalServer, localServer) && serversMatch(currentServer, localServer)) {
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

    if (!isCurrent()) return false;

    try {
      await this.#manager.switchTo(nextPlan, {
        timeoutMs: discoveryOptions.localSwitchTimeoutMs,
        expectedServer: localServer,
      });
      this.#log("info", "Connected to local Kinopio leaf", {
        from: currentServer,
        to: localServer,
        discoveryNamespace: manifest.discoveryNamespace || null,
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

  stop() {
    this.#stopped = true;
    this.#generation += 1;
    this.#clearProbeTimer();
    this.#fetchAbortController?.abort(new Error("Discovery prober stopped"));
    this.#fetchAbortController = null;
    this.clearManifestCache();
    this.#probePromise = null;
  }

  /** Allow restart after a reconnect() (stop() is called during cleanup). */
  reset() {
    this.#stopped = false;
  }
}
