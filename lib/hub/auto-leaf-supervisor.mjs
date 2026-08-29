// Auto-leaf supervision: start a local leaf in Node runtimes, follow its
// discovery manifest, and restart it when the active remote changes. The
// leaf entrypoint is loaded lazily via dynamic import so the hub's static
// import graph stays browser-safe.

import { isNodeRuntime, isPlainObject } from "../shared/assert.mjs";
import {
  deriveDefaultBackboneServer,
  normalizeDiscoveryEndpointUrl,
  serversMatch,
  uniqueServers,
} from "../shared/url.mjs";

const MONITOR_INTERVAL_MS = 250;

async function importLeafEntrypoint() {
  return await import(new URL("../../leaf.mjs", import.meta.url).href);
}

export class AutoLeafSupervisor {
  #hubOptions;
  #log;
  #manager;
  #isBrowser;
  #onDiscoveryStateChanged;

  #handle = null;
  #startupPromise = null;
  #monitorTimer = null;
  #manifestUrl = null;
  #namespace = null;
  #backboneServersKey = null;

  /**
   * @param {object} deps
   * @param {object} deps.hubOptions - resolved hub options
   * @param {Function} deps.log
   * @param {import("./connection-manager.mjs").ConnectionManager} deps.manager
   * @param {boolean} deps.isBrowser
   * @param {() => void} [deps.onDiscoveryStateChanged] - fired when the auto
   *   leaf's manifest URL or namespace changed (hub re-primes discovery)
   */
  constructor({ hubOptions, log, manager, isBrowser, onDiscoveryStateChanged }) {
    this.#hubOptions = hubOptions;
    this.#log = log;
    this.#manager = manager;
    this.#isBrowser = isBrowser;
    this.#onDiscoveryStateChanged = onDiscoveryStateChanged ?? null;
  }

  /** Manifest URL advertised by the auto-started leaf (discovery follows it). */
  get manifestUrl() {
    return this.#manifestUrl;
  }

  get namespace() {
    return this.#namespace;
  }

  get handle() {
    return this.#handle;
  }

  resolveOptions() {
    if (this.#isBrowser || !isNodeRuntime()) {
      return null;
    }

    const autoLeaf = this.#hubOptions.autoLeaf;
    if (autoLeaf === false) {
      return null;
    }

    if (autoLeaf === true || autoLeaf === undefined) {
      const backboneServers = this.#getDefaultBackboneServers();
      if (backboneServers.length === 0) {
        return null;
      }

      return {
        enabled: true,
        discoveryNamespace: "local",
        backboneServers,
        webSocketTls: false,
      };
    }

    if (!isPlainObject(autoLeaf)) {
      return null;
    }

    if (autoLeaf.enabled === false) {
      return null;
    }

    const hasExplicitBackboneServers = Object.hasOwn(autoLeaf, "backboneServers");
    const backboneServers = hasExplicitBackboneServers ? [] : this.#getDefaultBackboneServers();
    if (!hasExplicitBackboneServers && backboneServers.length === 0) {
      return null;
    }

    return {
      ...autoLeaf,
      enabled: true,
      backboneServers: hasExplicitBackboneServers
        ? autoLeaf.backboneServers
        : backboneServers,
      discoveryNamespace:
        typeof autoLeaf.discoveryNamespace === "string" && autoLeaf.discoveryNamespace.trim() !== ""
          ? autoLeaf.discoveryNamespace.trim()
          : "local",
      webSocketTls: autoLeaf.webSocketTls === true,
    };
  }

  #getDefaultBackboneServers() {
    const currentPlan = this.#manager.activePlan;
    if (!currentPlan || currentPlan.discoveryLocalServer) {
      return [];
    }

    const connectedServer =
      this.#manager.connection?.getServer?.() ||
      currentPlan.connectedServer ||
      null;
    if (!connectedServer) {
      return [];
    }

    const candidates = [
      ...(currentPlan.sourceCandidates || []),
      ...(currentPlan.orderedCandidates || []),
    ];
    const connectedCandidate = candidates.find((candidate) => serversMatch(candidate, connectedServer));
    const orderedCandidates = connectedCandidate
      ? [
          connectedCandidate,
          ...candidates.filter((candidate) => !serversMatch(candidate, connectedCandidate)),
        ]
      : candidates;

    return uniqueServers(
      orderedCandidates
        .map(deriveDefaultBackboneServer)
        .filter(Boolean),
    );
  }

  /** (Re)start the auto leaf so its backbone follows the active remote. */
  async syncForActiveRemote() {
    const autoLeafOptions = this.resolveOptions();
    if (!autoLeafOptions) {
      await this.dispose();
      return null;
    }

    const nextBackboneServersKey = JSON.stringify(autoLeafOptions.backboneServers || []);
    if (this.#handle && this.#backboneServersKey === nextBackboneServersKey) {
      return this.#handle;
    }

    if (this.#handle || this.#startupPromise) {
      await this.dispose();
    }

    this.#backboneServersKey = nextBackboneServersKey;
    return await this.#init(autoLeafOptions);
  }

  async #init(autoLeafOptions) {
    if (this.#startupPromise || this.#handle) {
      return this.#handle;
    }

    let startupPromise;
    startupPromise = (async () => {
      const { enableAutoLeaf } = await importLeafEntrypoint();
      const handle = await enableAutoLeaf(autoLeafOptions);
      if (this.#startupPromise === startupPromise) {
        this.#handle = handle;
        await this.#refreshDiscoveryState();
        this.#scheduleMonitor();
      }
      this.#log("info", "Auto leaf started for this Node runtime", {
        discoveryNamespace: autoLeafOptions.discoveryNamespace,
        webSocketTls: autoLeafOptions.webSocketTls !== false,
      });
      return handle;
    })();

    this.#startupPromise = startupPromise;

    try {
      return await startupPromise;
    } catch (error) {
      this.#log("warn", "Auto leaf startup failed; continuing without a local leaf", error);
      return null;
    } finally {
      if (this.#startupPromise === startupPromise) {
        this.#startupPromise = null;
      }
    }
  }

  #readManifestUrlFromStatus() {
    const status = this.#handle?.status?.();
    const manifestUrl =
      status?.localLeaf?.manifest?.discoveryUrl ||
      status?.leader?.discoveryUrl ||
      null;

    return typeof manifestUrl === "string" && manifestUrl.trim() !== ""
      ? normalizeDiscoveryEndpointUrl(manifestUrl, "auto leaf discovery manifest URL")
      : null;
  }

  async #refreshDiscoveryState() {
    if (!this.#handle) {
      this.#manifestUrl = null;
      this.#namespace = null;
      return;
    }

    const status = this.#handle.status?.();
    const nextManifestUrl = this.#readManifestUrlFromStatus();
    const nextNamespace =
      status?.localLeaf?.manifest?.discoveryNamespace ||
      status?.leader?.discoveryNamespace ||
      status?.discoveryNamespace ||
      null;
    const manifestChanged = nextManifestUrl !== this.#manifestUrl;
    const namespaceChanged = nextNamespace !== this.#namespace;

    this.#manifestUrl = nextManifestUrl;
    this.#namespace =
      typeof nextNamespace === "string" && nextNamespace.trim() !== ""
        ? nextNamespace
        : null;

    if (manifestChanged || namespaceChanged) {
      this.#onDiscoveryStateChanged?.();
    }
  }

  #clearMonitorTimer() {
    if (!this.#monitorTimer) return;
    clearTimeout(this.#monitorTimer);
    this.#monitorTimer = null;
  }

  #scheduleMonitor(delayMs = MONITOR_INTERVAL_MS) {
    this.#clearMonitorTimer();
    if (!this.#handle) {
      return;
    }

    this.#monitorTimer = setTimeout(() => {
      this.#monitorTimer = null;
      this.#refreshDiscoveryState()
        .catch((error) => {
          this.#log("warn", "Failed to refresh auto leaf discovery state:", error);
        })
        .finally(() => {
          if (this.#handle) {
            this.#scheduleMonitor(delayMs);
          }
        });
    }, Math.max(0, delayMs));
    this.#monitorTimer.unref?.();
  }

  async dispose() {
    this.#clearMonitorTimer();

    let handle = this.#handle;
    this.#handle = null;
    this.#manifestUrl = null;
    this.#namespace = null;
    this.#backboneServersKey = null;

    const startupPromise = this.#startupPromise;
    this.#startupPromise = null;

    if (!handle && startupPromise) {
      try {
        handle = await startupPromise;
      } catch {
        handle = null;
      }
    }

    if (handle?.stop) {
      await handle.stop();
    }
  }
}
