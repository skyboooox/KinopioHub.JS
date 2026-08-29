// Minimal per-instance event emitter. Replaces the process-global bus that
// kinopio-hub <= 2.1.x used (which cross-fired state events between hub
// instances in the same process).

export class Emitter {
  #listeners = new Map();
  #onListenerError;

  constructor({ onListenerError } = {}) {
    this.#onListenerError = onListenerError ?? null;
  }

  on(eventName, listener) {
    if (typeof listener !== "function") {
      throw new TypeError("listener must be a function");
    }

    let bucket = this.#listeners.get(eventName);
    if (!bucket) {
      bucket = new Set();
      this.#listeners.set(eventName, bucket);
    }
    bucket.add(listener);
    return () => this.off(eventName, listener);
  }

  off(eventName, listener) {
    const bucket = this.#listeners.get(eventName);
    if (!bucket) return;
    bucket.delete(listener);
    if (bucket.size === 0) {
      this.#listeners.delete(eventName);
    }
  }

  emit(eventName, ...args) {
    const bucket = this.#listeners.get(eventName);
    if (!bucket) return;
    for (const listener of [...bucket]) {
      try {
        listener(...args);
      } catch (error) {
        this.#onListenerError?.(eventName, error);
      }
    }
  }

  removeAllListeners() {
    this.#listeners.clear();
  }
}
