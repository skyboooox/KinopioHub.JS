// Subscription registry with per-caller fan-out.
//
// One wire (NATS) subscription exists per (subject, options-key). Every
// sub() call adds its own SubscriberHandle to that entry and every message is
// delivered to every active handle — fixing the 2.1.x first-wins dedupe where
// a second sub() with equivalent options silently dropped its callback and
// returned the first caller's handle (GitHub issue #2). A handle's
// unsubscribe() removes only that caller; the wire subscription is released
// when the last handle leaves.
//
// Rebinding to a new connection (reconnect / latency or discovery hot switch)
// explicitly unsubscribes the previous wire subscription and bumps the
// entry's pump epoch so the stale pump loop terminates — 2.1.x silently
// overwrote the wire handle, orphaning the old subscription.

/**
 * Options-derived identity for a wire subscription. Explicit `max` presence
 * is part of the key so `max: 0` is distinct from "no max".
 */
export function subscriptionOptionsKey(options = {}) {
  return JSON.stringify({
    queue: options.queue ?? null,
    hasMax: Object.hasOwn(options, "max"),
    max: options.max ?? null,
    headers: options.headers ?? null,
  });
}

export class SubscriberHandle {
  #active = true;
  #onUnsubscribe;
  #iteratorEnabled = false;
  #iteratorQueue = [];
  #iteratorWaiters = [];
  #callbackChain = Promise.resolve();
  callback;

  constructor(callback, onUnsubscribe = null) {
    this.callback = callback;
    this.#onUnsubscribe = onUnsubscribe;
  }

  get active() {
    return this.#active;
  }

  /**
   * @internal Queue a callback invocation. Per-handle ordering is preserved
   * via a promise chain, but handles never wait on each other — one caller's
   * hanging callback cannot starve the other subscribers of the same wire
   * subscription.
   */
  dispatch(data, message, onError) {
    if (typeof this.callback !== "function") return;
    this.#callbackChain = this.#callbackChain
      .then(async () => {
        if (!this.#active) return;
        await this.callback(data, message);
      })
      .catch((error) => {
        onError?.(error);
      });
  }

  /** @internal Feed the per-handle async iterator. */
  notify(message) {
    if (!this.#active || !this.#iteratorEnabled) return;

    const waiter = this.#iteratorWaiters.shift();
    if (waiter) {
      waiter({ value: message, done: false });
      return;
    }

    this.#iteratorQueue.push(message);
  }

  /** @internal Mark done without detaching from the entry (wire completed). */
  complete() {
    if (!this.#active) return;
    this.#active = false;
    this.#finishIterators();
  }

  unsubscribe() {
    if (!this.#active) return;

    this.#active = false;
    try {
      this.#finishIterators();
    } finally {
      this.#onUnsubscribe?.(this);
    }
  }

  #finishIterators() {
    this.#iteratorQueue.length = 0;
    while (this.#iteratorWaiters.length > 0) {
      const waiter = this.#iteratorWaiters.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator]() {
    this.#iteratorEnabled = true;

    return {
      next: () => {
        if (this.#iteratorQueue.length > 0) {
          return Promise.resolve({ value: this.#iteratorQueue.shift(), done: false });
        }

        if (!this.#active) {
          return Promise.resolve({ value: undefined, done: true });
        }

        return new Promise((resolve) => {
          this.#iteratorWaiters.push(resolve);
        });
      },
      return: async () => {
        this.unsubscribe();
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}

export class SubscriptionRegistry {
  // `${subject}\u0000${optionsKey}` -> subscriber entry
  #subEntries = new Map();
  // subject -> service entry (one service per subject)
  #serviceEntries = new Map();
  // subject -> value tracker entry
  #valueEntries = new Map();
  #serialize;
  #deserialize;
  #log;
  #disposed = false;

  constructor({ serialize, deserialize, log }) {
    this.#serialize = serialize;
    this.#deserialize = deserialize;
    this.#log = log;
  }

  /** Add a fan-out subscriber. Returns the caller's own handle. */
  addSubscriber(subject, callback, options, connection) {
    const key = subscriptionOptionsKey(options);
    const entryKey = `${subject}\u0000${key}`;
    let entry = this.#subEntries.get(entryKey);

    if (!entry) {
      entry = {
        kind: "sub",
        subject,
        key,
        options,
        connection: null,
        natsSubscription: null,
        pumpEpoch: 0,
        handles: new Set(),
      };
      this.#subEntries.set(entryKey, entry);
    }

    const handle = new SubscriberHandle(callback, (leaving) => {
      entry.handles.delete(leaving);
      if (entry.handles.size === 0) {
        this.#teardownEntry(entry);
        this.#subEntries.delete(entryKey);
      }
    });
    entry.handles.add(handle);

    if (!entry.natsSubscription && connection) {
      try {
        this.#bindSubscriberEntry(entry, connection);
      } catch (error) {
        // Roll back the ghost handle/entry so a failed subscribe cannot be
        // resurrected by a later rebind.
        entry.handles.delete(handle);
        if (entry.handles.size === 0) {
          this.#subEntries.delete(entryKey);
        }
        throw error;
      }
    }

    return handle;
  }

  /** Install the subject's request handler, replacing any previous one. */
  setService(subject, handler, options, connection) {
    const previous = this.#serviceEntries.get(subject);
    if (previous) {
      this.#log("debug", `Stopping service: ${subject}`);
      try {
        previous.handle.unsubscribe();
      } catch (error) {
        this.#log("warn", "Failed to stop existing service:", error);
      }
    }

    const entry = {
      kind: "service",
      subject,
      options,
      handler,
      connection: null,
      natsSubscription: null,
      pumpEpoch: 0,
      handle: null,
    };
    entry.handle = new SubscriberHandle(null, () => {
      this.#teardownEntry(entry);
      if (this.#serviceEntries.get(subject) === entry) {
        this.#serviceEntries.delete(subject);
      }
    });

    this.#serviceEntries.set(subject, entry);
    if (connection) {
      try {
        this.#bindServiceEntry(entry, connection);
      } catch (error) {
        // The previous service was already stopped; remove the ghost entry so
        // the failure is not silently "fixed" by a later rebind.
        if (this.#serviceEntries.get(subject) === entry) {
          this.#serviceEntries.delete(subject);
        }
        throw error;
      }
    }
    return entry.handle;
  }

  /** Track the latest value published on a subject (internal Variable feed). */
  setValueTracker(subject, onValue, connection) {
    let entry = this.#valueEntries.get(subject);
    if (!entry) {
      entry = {
        kind: "value",
        subject,
        onValue,
        connection: null,
        natsSubscription: null,
        pumpEpoch: 0,
      };
      this.#valueEntries.set(subject, entry);
    } else {
      entry.onValue = onValue;
    }

    if (connection && entry.connection !== connection) {
      this.#bindValueEntry(entry, connection);
    }
    return entry;
  }

  hasValueTracker(subject) {
    const entry = this.#valueEntries.get(subject);
    return Boolean(entry?.natsSubscription);
  }

  /** Rebind every live entry onto a (new) connection. */
  rebindAll(connection) {
    for (const entry of this.#valueEntries.values()) {
      this.#bindValueEntry(entry, connection);
    }
    for (const entry of this.#subEntries.values()) {
      if (entry.handles.size === 0) continue;
      this.#bindSubscriberEntry(entry, connection);
    }
    for (const entry of this.#serviceEntries.values()) {
      if (!entry.handle.active) continue;
      this.#bindServiceEntry(entry, connection);
    }
  }

  /** Tear down everything registered for one subject (Variable.dispose). */
  disposeSubject(subject) {
    for (const [entryKey, entry] of [...this.#subEntries]) {
      if (entry.subject !== subject) continue;
      for (const handle of [...entry.handles]) {
        this.#safeUnsubscribeHandle(handle, entryKey);
      }
    }

    const service = this.#serviceEntries.get(subject);
    if (service) {
      this.#safeUnsubscribeHandle(service.handle, `${subject} service`);
    }

    const value = this.#valueEntries.get(subject);
    if (value) {
      this.#teardownEntry(value);
      this.#valueEntries.delete(subject);
    }
  }

  disposeAll() {
    this.#disposed = true;
    for (const subject of new Set([
      ...[...this.#subEntries.values()].map((entry) => entry.subject),
      ...this.#serviceEntries.keys(),
      ...this.#valueEntries.keys(),
    ])) {
      this.disposeSubject(subject);
    }
    this.#subEntries.clear();
    this.#serviceEntries.clear();
    this.#valueEntries.clear();
  }

  /** Undocumented-but-present 2.x surface: `${subject}_${key}` -> handle-like. */
  buildLegacyHandleMap() {
    const map = new Map();
    for (const entry of this.#subEntries.values()) {
      const [firstHandle] = entry.handles;
      if (firstHandle) {
        map.set(`${entry.subject}_${entry.key}`, firstHandle);
      }
    }
    for (const [subject, entry] of this.#serviceEntries) {
      map.set(`${subject}_service`, entry.handle);
    }
    return map;
  }

  #safeUnsubscribeHandle(handle, label) {
    try {
      handle.unsubscribe();
    } catch (error) {
      this.#log("warn", `Cleanup failed: ${label}`, error);
    }
  }

  /** Unsubscribe the current wire subscription and invalidate its pump. */
  #teardownEntry(entry) {
    entry.pumpEpoch += 1;
    const subscription = entry.natsSubscription;
    entry.natsSubscription = null;
    entry.connection = null;
    if (subscription) {
      try {
        subscription.unsubscribe();
      } catch {
        // The connection may already be gone; nothing to release.
      }
    }
  }

  #rebindWire(entry, connection) {
    this.#teardownEntry(entry);
    const epoch = entry.pumpEpoch;
    const subscription = connection.subscribe(entry.subject, entry.options ?? {});
    entry.natsSubscription = subscription;
    entry.connection = connection;
    return { subscription, epoch };
  }

  #bindSubscriberEntry(entry, connection) {
    const { subscription, epoch } = this.#rebindWire(entry, connection);
    void this.#pumpSubscribers(entry, subscription, epoch);
  }

  #bindServiceEntry(entry, connection) {
    const { subscription, epoch } = this.#rebindWire(entry, connection);
    void this.#pumpService(entry, subscription, epoch, connection);
  }

  #bindValueEntry(entry, connection) {
    const { subscription, epoch } = this.#rebindWire(entry, connection);
    void this.#pumpValues(entry, subscription, epoch);
  }

  async #pumpSubscribers(entry, subscription, epoch) {
    try {
      for await (const message of subscription) {
        if (entry.pumpEpoch !== epoch) return;

        let data;
        try {
          data = this.#deserialize(message.data);
        } catch (error) {
          this.#log("error", `Msg error: ${entry.subject}`, error);
          continue;
        }

        for (const handle of [...entry.handles]) {
          if (!handle.active) continue;
          handle.notify(message);
          handle.dispatch(data, message, (error) => {
            this.#log("error", `Msg error: ${entry.subject}`, error);
          });
        }
      }

      // The wire subscription completed on its own (e.g. `max` reached).
      if (entry.pumpEpoch === epoch) {
        for (const handle of [...entry.handles]) {
          handle.complete();
        }
        entry.handles.clear();
        entry.natsSubscription = null;
        this.#subEntries.delete(`${entry.subject}\u0000${entry.key}`);
      }
    } catch (error) {
      if (entry.pumpEpoch === epoch && !this.#disposed) {
        this.#log("error", `Iterator error: ${entry.subject}`, error);
      }
    }
  }

  async #pumpService(entry, subscription, epoch, connection) {
    try {
      for await (const message of subscription) {
        if (entry.pumpEpoch !== epoch) return;

        try {
          const requestData = this.#deserialize(message.data);
          this.#log("debug", `Received service request for ${entry.subject}:`, requestData);

          let responseData;
          try {
            responseData = await entry.handler(requestData, message);
          } catch (handlerError) {
            this.#log("error", `Handler error: ${entry.subject}`, handlerError);
            responseData = {
              error: true,
              message: handlerError?.message || "Service handler error",
            };
          }

          if (message.reply) {
            connection.publish(message.reply, this.#serialize(responseData));
            this.#log("debug", `Sent service response for ${entry.subject}:`, responseData);
          }
        } catch (error) {
          this.#log("error", `Request error: ${entry.subject}`, error);
        }
      }
    } catch (error) {
      if (entry.pumpEpoch === epoch && !this.#disposed) {
        this.#log("error", `Service error: ${entry.subject}`, error);
      }
    }
  }

  async #pumpValues(entry, subscription, epoch) {
    try {
      for await (const message of subscription) {
        if (entry.pumpEpoch !== epoch) return;

        try {
          entry.onValue(this.#deserialize(message.data), message);
        } catch (error) {
          this.#log("error", `Value error: ${entry.subject}`, error);
        }
      }
    } catch (error) {
      if (entry.pumpEpoch === epoch && !this.#disposed) {
        this.#log("error", `Value tracking iterator error for ${entry.subject}:`, error);
      }
    }
  }
}
