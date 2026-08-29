// KinopioHub — the public client. Composes option resolution, the
// per-instance state event emitter, the data codec, the fan-out subscription
// registry, the connection manager, background local-leaf discovery, and the
// auto-leaf supervisor.
//
// State events are per instance: two hubs in one process no longer cross-fire
// each other's onStateChange listeners or connected() waiters (2.1.x used a
// process-global emitter).

import { Emitter } from "../shared/emitter.mjs";
import { DataCodec } from "../shared/codec.mjs";
import { AutoLeafSupervisor } from "./auto-leaf-supervisor.mjs";
import { ConnectionManager } from "./connection-manager.mjs";
import { KINOPIO_STATE_EVENT } from "./constants.mjs";
import { DiscoveryProber } from "./discovery.mjs";
import { createLogger } from "./logger.mjs";
import { resolveDiscoveryOptions, resolveHubOptions } from "./options.mjs";
import { GUARDED_PROXY_PROPS, Scope } from "./scope.mjs";
import { SubscriptionRegistry } from "./subscriptions.mjs";

export { KINOPIO_STATE_EVENT } from "./constants.mjs";

function detectBrowser() {
  try {
    return typeof window !== "undefined" &&
      typeof window.document !== "undefined" &&
      typeof window.location !== "undefined";
  } catch {
    return false;
  }
}

export class KinopioHub {
  #options;
  #events;
  #codec;
  #registry;
  #manager;
  #discovery;
  #autoLeaf;
  #scopes = new Map();
  #variables = new Set();
  #log;

  constructor(options = {}) {
    this.#options = resolveHubOptions(options);

    this.isBrowser = detectBrowser();
    this.debug = this.#options.debug;
    this.#log = createLogger(() => this.debug);

    this.#codec = new DataCodec({
      codec: this.#options.codec,
      jsonReplacer: this.#options.jsonReplacer,
      jsonReviver: this.#options.jsonReviver,
      log: (...args) => this.#log(...args),
    });
    this.textEncoder = this.#codec.textEncoder;
    this.textDecoder = this.#codec.textDecoder;

    this.#events = new Emitter({
      onListenerError: (eventName, error) => {
        this.#log("error", `Listener error for ${eventName}:`, error);
      },
    });

    this.#registry = new SubscriptionRegistry({
      serialize: (data) => this.#codec.serialize(data),
      deserialize: (bytes) => this.#codec.deserialize(bytes),
      log: (...args) => this.#log(...args),
    });

    this.#manager = new ConnectionManager({
      options: this.#options,
      log: (...args) => this.#log(...args),
      events: this.#events,
      rebindAll: async (connection) => {
        this.#registry.rebindAll(connection);
      },
      onEstablished: async (plan, _connection, { initial }) => {
        this.#discovery.reset();
        if (!plan.discoveryLocalServer) {
          await this.#autoLeaf.syncForActiveRemote();
        }
        await this.#discovery.start({ immediateProbe: initial });
      },
      onServerChanged: async () => {
        await this.#autoLeaf.syncForActiveRemote();
        await this.#discovery.start({ immediateProbe: true });
      },
    });

    this.#autoLeaf = new AutoLeafSupervisor({
      hubOptions: this.#options,
      log: (...args) => this.#log(...args),
      manager: this.#manager,
      isBrowser: this.isBrowser,
      onDiscoveryStateChanged: () => {
        this.#discovery.clearManifestCache();
        if (this.#manager.connection && this.#manager.state === "connected") {
          this.#discovery.scheduleProbeCycle(0);
        }
      },
    });

    this.#discovery = new DiscoveryProber({
      manager: this.#manager,
      log: (...args) => this.#log(...args),
      hubOptions: this.#options,
      getDiscoveryOptions: () =>
        resolveDiscoveryOptions(this.#options, {
          isBrowser: this.isBrowser,
          autoLeafManifestUrl: this.#autoLeaf.manifestUrl,
        }),
    });

    if (this.#options.autoConnect !== false) {
      const timer = setTimeout(() => {
        this.connect().catch((error) => {
          // State is already "error"; connected() waiters observe it. An
          // unhandled rejection here would tear the process down.
          this.#log("error", "Auto-connect failed:", error.message);
        });
      }, 0);
      timer.unref?.();
    }

    return this.#createProxy();
  }

  #createProxy() {
    return new Proxy(this, {
      get: (target, prop) => {
        if (prop in target || typeof prop === "symbol") {
          const value = target[prop];
          if (typeof value === "function") {
            return value.bind(target);
          }
          return value;
        }
        if (GUARDED_PROXY_PROPS.has(prop)) {
          return undefined;
        }
        return target.getScope(prop);
      },
      set: (target, prop, value) => {
        if (prop === "state" || prop === "isConnected" || prop === "nats") {
          target.#log("warn", `Cannot set readonly property '${prop}' on KinopioHub`);
          return true;
        }
        target[prop] = value;
        return true;
      },
    });
  }

  // ---- state ---------------------------------------------------------------

  get state() {
    return this.#manager.state;
  }

  get isConnected() {
    return this.#manager.isConnected;
  }

  get nats() {
    return this.#manager.connection;
  }

  get subscriptions() {
    return this.#registry.buildLegacyHandleMap();
  }

  get healthCheckActive() {
    return this.#manager.healthCheckActive;
  }

  /** @internal shared subscription registry (used by Scope/Variable). */
  get _registry() {
    return this.#registry;
  }

  // ---- lifecycle -----------------------------------------------------------

  async connect() {
    return await this.#manager.connect();
  }

  async connected(timeoutMs = 10_000) {
    return await this.#manager.waitForConnected(timeoutMs);
  }

  async reconnect() {
    this.#discovery.stop();
    this.#discovery.reset();
    await this.#manager.reconnect();
  }

  async dispose() {
    this.#log("info", "Disposing");

    this.#discovery.stop();

    for (const [, scope] of [...this.#scopes]) {
      scope.dispose();
    }
    this.#scopes.clear();
    this.#registry.disposeAll();

    await this.#manager.dispose();
    await this.#autoLeaf.dispose();
  }

  // ---- scopes --------------------------------------------------------------

  getScope(scopeName) {
    return this.#scopes.get(scopeName) ?? (() => {
      const scope = new Scope(this, scopeName);
      this.#scopes.set(scopeName, scope);
      this.#log("debug", `New scope: ${scopeName}`);
      return scope;
    })();
  }

  /** @internal called by Scope.dispose(). */
  _removeScope(scopeName) {
    this.#scopes.delete(scopeName);
  }

  registerVariable(variable) {
    this.#variables.add(variable);
  }

  unregisterVariable(variable) {
    this.#variables.delete(variable);
  }

  // ---- messaging -----------------------------------------------------------

  async request(subject, data, options = {}) {
    await this.connected();

    const connection = this.#manager.connection;
    if (!connection) {
      throw new Error(`NATS connection not available for request to ${subject}`);
    }

    const timeout = options.timeout || 5000;

    try {
      const message = this.#codec.serialize(data);
      this.#log("debug", `Sending request to ${subject}`, { data, timeout });

      const response = await connection.request(subject, message, { timeout });
      const responseData = this.#codec.deserialize(response.data);

      this.#log("debug", `Received response from ${subject}`, responseData);
      return responseData;
    } catch (error) {
      this.#log("error", `Request failed for ${subject}:`, error);
      throw error;
    }
  }

  // ---- events --------------------------------------------------------------

  onStateChange(listener) {
    return this.#events.on(KINOPIO_STATE_EVENT, listener);
  }

  offStateChange(listener) {
    this.#events.off(KINOPIO_STATE_EVENT, listener);
  }

  // ---- data ----------------------------------------------------------------

  serializeData(data) {
    return this.#codec.serialize(data);
  }

  deserializeData(uint8Array) {
    return this.#codec.deserialize(uint8Array);
  }

  log(level, message, ...args) {
    return this.#log(level, message, ...args);
  }
}
