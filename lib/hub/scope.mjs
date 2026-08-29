// Scope and Variable: the subject-as-variable user surface.
//
// Both wrap themselves in Proxies for the documented dynamic access
// (`hub.myScope.myVar`). Well-known protocol properties are excluded so
// `await hub`, `JSON.stringify(hub)`, and console inspection no longer mint
// scopes/variables named "then" / "toJSON" (a 2.1.x quirk).

import { bytesEqual } from "../shared/codec.mjs";

export const GUARDED_PROXY_PROPS = new Set([
  "then",
  "catch",
  "finally",
  "toJSON",
  "inspect",
]);

const VALUE_TRACKING_RETRY_MS = 1_000;
const VALUE_TRACKING_ERROR_RETRY_MS = 2_000;
const ENSURE_CONNECTION_MAX_RETRIES = 3;

export class Scope {
  #hub;
  #scopeName;
  #variables = new Map();

  constructor(hub, scopeName) {
    this.#hub = hub;
    this.#scopeName = scopeName;

    return new Proxy(this, {
      get: (target, prop) => {
        if (prop in target || typeof prop === "symbol") {
          const value = target[prop];
          // Bind methods so private-field access keeps working through the proxy.
          if (typeof value === "function") {
            return value.bind(target);
          }
          return value;
        }
        if (GUARDED_PROXY_PROPS.has(prop)) {
          return undefined;
        }
        return target.getVariable(prop);
      },
    });
  }

  getVariable(varName) {
    return this.#variables.get(varName) ?? (() => {
      const variable = new Variable(this.#hub, this.#scopeName, varName, {
        onDispose: () => {
          this.#variables.delete(varName);
        },
      });
      this.#variables.set(varName, variable);
      this.#hub.registerVariable(variable);
      return variable;
    })();
  }

  dispose() {
    for (const [, variable] of [...this.#variables]) {
      this.#hub.unregisterVariable(variable);
      variable.dispose();
    }
    this.#variables.clear();
    this.#hub._removeScope(this.#scopeName);
  }
}

export class Variable {
  #hub;
  #subject;
  #onDispose;
  #lastPublishedMessage = null;
  #latestValue = null;
  #valueTrackingRetryTimer = null;
  #disposed = false;

  constructor(hub, scopeName, varName, { onDispose } = {}) {
    this.#hub = hub;
    this.#subject = `${scopeName}.${varName}`;
    this.#onDispose = onDispose ?? null;

    void this.#startValueTracking();

    return new Proxy(this, {
      get: (target, prop) => {
        if (prop === "value") {
          return target.#latestValue;
        }
        if (prop in target || typeof prop === "symbol") {
          const value = target[prop];
          if (typeof value === "function") {
            return value.bind(target);
          }
          return value;
        }
        return undefined;
      },
      set: (target, prop, value) => {
        if (prop === "value" || prop === "subject") {
          target.#hub.log("warn", `Cannot set readonly property '${prop}' on Variable ${target.#subject}`);
          return true;
        }
        target[prop] = value;
        return true;
      },
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
      this.#startValueTracking().catch((error) => {
        this.#hub.log("debug", `Value tracking retry failed for ${this.#subject}:`, error.message);
      });
    }, delayMs);
    this.#valueTrackingRetryTimer.unref?.();
  }

  async #startValueTracking() {
    if (this.#disposed || this.#hub._registry.hasValueTracker(this.#subject)) return;

    try {
      await this.#hub.connected();

      if (this.#disposed) return;

      const connection = this.#hub.nats;
      if (!connection) {
        this.#hub.log("debug", `NATS connection not available for ${this.#subject}, waiting...`);
        this.#scheduleValueTrackingRetry(VALUE_TRACKING_RETRY_MS);
        return;
      }

      this.#hub._registry.setValueTracker(
        this.#subject,
        (data) => {
          this.#latestValue = data;
          this.#hub.log("debug", `Value updated: ${this.#subject}`, data);
        },
        connection,
      );
      this.#clearValueTrackingRetry();
      this.#hub.log("debug", `Value tracking started: ${this.#subject}`);
    } catch (error) {
      if (this.#disposed) return;
      this.#hub.log("debug", `Value tracking failed: ${this.#subject}, will retry...`, error.message);
      this.#scheduleValueTrackingRetry(VALUE_TRACKING_ERROR_RETRY_MS);
    }
  }

  /**
   * Wait for a live connection and return it. Retries briefly when the hub
   * reports connected but the connection object is (transiently) missing —
   * and, unlike 2.1.x, never dereferences a null connection.
   */
  async #requireConnection(operation) {
    let retryCount = 0;

    for (;;) {
      await this.#hub.connected();
      const connection = this.#hub.nats;
      if (connection && !(connection.isClosed?.() === true)) {
        return connection;
      }

      retryCount++;
      if (retryCount >= ENSURE_CONNECTION_MAX_RETRIES) {
        throw new Error(`NATS connection not available for ${operation} on ${this.#subject}`);
      }
      this.#hub.log("warn", `NATS connection not available for ${operation} on ${this.#subject}, retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 100 * retryCount));
    }
  }

  async pub(data, options = {}) {
    const connection = await this.#requireConnection("publishing");

    try {
      const message = this.#hub.serializeData(data);

      if (this.#lastPublishedMessage && bytesEqual(message, this.#lastPublishedMessage)) {
        this.#hub.log("debug", `Skipped duplicate: ${this.#subject}`);
        return;
      }

      connection.publish(this.#subject, message, options);
      // Snapshot the bytes: `message` may be the caller's own Uint8Array, and
      // a caller mutating it in place must not corrupt duplicate detection.
      this.#lastPublishedMessage = message.slice();
      this.#latestValue = data;

      this.#hub.log("debug", `Published: ${this.#subject}`, { message, options });
    } catch (error) {
      this.#hub.log("error", `Publish failed: ${this.#subject}`, error);
      throw error;
    }
  }

  async sub(callback, options = {}) {
    const connection = await this.#requireConnection("subscription");

    try {
      const handle = this.#hub._registry.addSubscriber(this.#subject, callback, options, connection);
      this.#hub.log("debug", `Subscribed: ${this.#subject}`, options);
      return handle;
    } catch (error) {
      this.#hub.log("error", `Sub failed: ${this.#subject}`, error);
      throw error;
    }
  }

  async req(data, options = {}) {
    const connection = await this.#requireConnection("request");

    const timeout = options.timeout || 5000;

    try {
      const message = this.#hub.serializeData(data);
      const response = await connection.request(this.#subject, message, { timeout });

      this.#hub.log("debug", `Request sent to ${this.#subject}`, { message, timeout });
      return this.#hub.deserializeData(response.data);
    } catch (error) {
      this.#hub.log("error", `Request failed for ${this.#subject}:`, error);
      throw error;
    }
  }

  async serve(handler, options = {}) {
    const connection = await this.#requireConnection("service");

    try {
      const normalizedOptions = {
        ...options,
        queue: options.queue || `${this.#subject}.service`,
      };

      const handle = this.#hub._registry.setService(this.#subject, handler, normalizedOptions, connection);
      this.#hub.log("debug", `Service started: ${this.#subject}`, normalizedOptions);
      return handle;
    } catch (error) {
      this.#hub.log("error", `Service failed: ${this.#subject}`, error);
      throw error;
    }
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearValueTrackingRetry();

    this.#hub._registry.disposeSubject(this.#subject);
    this.#hub.unregisterVariable(this);
    this.#onDispose?.();

    this.#lastPublishedMessage = null;
    this.#latestValue = null;
  }
}
