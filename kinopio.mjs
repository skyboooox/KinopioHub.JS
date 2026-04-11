import { wsconnect } from "@nats-io/nats-core";
import { event } from "skyboxtool";

export const KINOPIO_STATE_EVENT = "kinopio.state";

/**
 * KinopioHub - A modern NATS client for real-time communication
 * 
 * @class KinopioHub
 * @description 
 * 
 * @example
 * ```js
 * // Create a new instance
 * const hub = new KinopioHub({
 *   servers: ["wss://nats.example.com:443"],
 *   debug: true
 * });
 * 
 * // Use scoped variables
 * const myScope = hub.getScope("myScope");
 * const myVar = myScope.getVariable("myVar");
 * 
 * // Publish data
 * await myVar.pub({ message: "Hello!" });
 * 
 * // Subscribe to updates
 * await myVar.sub(data => {
 *   console.log("Received:", data);
 * });
 * ```
 */
export class KinopioHub {
  // Core connection and state management
  #nats = null;
  #options;
  #connectionPromise = null;
  #healthCheckActive = false;
  #activeTimers = new Set();
  #scopes = new Map();
  #subscriptions = new Map();
  #retryAttempt = 0;
  #currentRetryDelay = 0;
  
  /**
   * Creates a new KinopioHub instance
   * @param {Object} options - Configuration options
   * @param {boolean} [options.debug=false] - Enable debug logging
   * @param {string[]} [options.servers=["wss://demo.nats.io:8443"]] - NATS server URLs
   * @param {boolean} [options.noEcho=false] - Don't receive own published messages
   * @param {boolean} [options.noRandomize=true] - Don't randomize server list
   * @param {number} [options.maxReconnectAttempts=-1] - Max reconnection attempts (-1 for infinite)
   * @param {boolean} [options.waitOnFirstConnect=true] - Wait for first connection
   * @param {number} [options.reconnectTimeout=5000] - Reconnection timeout in ms
   * @param {number} [options.reconnectTimeWait=500] - Wait time between reconnects in ms
   * @param {number} [options.timeout=3000] - Operation timeout in ms
   * @param {boolean} [options.autoConnect=true] - Start connecting immediately
   * @param {boolean} [options.autoRetry=true] - Enable automatic retry on connection failure
   * @param {number} [options.retryDelay=1000] - Initial retry delay in ms
   * @param {number} [options.maxRetryDelay=30000] - Maximum retry delay in ms
   * @param {number} [options.retryBackoffFactor=1.5] - Backoff multiplier for retry delays
   * @param {Object} [options.codec] - Custom codec with encode(data) and decode(bytes)
   * @param {Function} [options.jsonReplacer] - JSON.stringify replacer
   * @param {Function} [options.jsonReviver] - JSON.parse reviver
   */
  constructor(options = {}) {
    // Default connection options
    this.#options = {
      debug: false,
      servers: ["wss://demo.nats.io:8443", "wss://demo.nats.io:4443"],
      noEcho: false,
      noRandomize: true,
      maxReconnectAttempts: -1,
      waitOnFirstConnect: true,
      reconnectTimeout: 5000,
      reconnectTimeWait: 500,
      pingInterval: 3000,
      maxPingOut: 3,
      timeout: 3000,
      healthReport: 5000,
      autoConnect: true,
      autoRetry: true,
      retryDelay: 1000,
      maxRetryDelay: 30000,
      retryBackoffFactor: 1.5,
      jsonReplacer: undefined,
      jsonReviver: undefined,
      codec: undefined,
      ...options,
    };

    // Environment detection
    this.isBrowser = this.#detectBrowser();
    this.textDecoder = this.#initTextDecoder();
    this.textEncoder = this.#initTextEncoder();
    
    // Initialize state
    this.state = "disconnected";
    this.isConnected = false;
    this.debug = this.#options.debug;
    
    // Start connection
    if (this.#options.autoConnect !== false) {
      this.#initConnection();
    }
    
    // Enable dynamic scope access
    return this.#createProxy();
  }

  // Check if running in browser environment
  #detectBrowser() {
    try {
      return typeof window !== "undefined" && 
             typeof window.document !== "undefined" &&
             typeof window.location !== "undefined";
    } catch {
      return false;
    }
  }

  // Initialize text decoder with fallback
  #initTextDecoder() {
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder("utf-8");
    }
    
    // Enhanced fallback with better error handling
    return {
      decode: (uint8Array) => {
        try {
          return String.fromCharCode(...uint8Array);
        } catch {
          // Fallback for large arrays
          return Array.from(uint8Array, byte => String.fromCharCode(byte)).join('');
        }
      }
    };
  }

  // Initialize text encoder with fallback
  #initTextEncoder() {
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder();
    }
    
    return {
      encode: (text) => {
        const result = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) {
          result[i] = text.charCodeAt(i);
        }
        return result;
      }
    };
  }

  // Timer management
  #createTimer(callback, delay) {
    const timerId = setTimeout(() => {
      this.#activeTimers.delete(timerId);
      callback();
    }, delay);
    this.#activeTimers.add(timerId);
    return timerId;
  }

  #clearTimer(timerId) {
    if (timerId && this.#activeTimers.has(timerId)) {
      clearTimeout(timerId);
      this.#activeTimers.delete(timerId);
    }
  }

  #clearAllTimers() {
    this.#activeTimers.forEach(timerId => clearTimeout(timerId));
    this.#activeTimers.clear();
  }

  // Create proxy for dynamic property access
  #createProxy() {
    return new Proxy(this, {
      get: (target, prop) => {
        if (prop in target || typeof prop === "symbol") {
          const value = target[prop];
          if (typeof value === 'function') {
            return value.bind(target);
          }
          return value;
        }
        return target.getScope(prop);
      }
    });
  }

  // Initialize NATS connection
  #initConnection() {
    this.#createTimer(() => this.connect(), 0);
  }

  // Log messages with timestamp
  #log(level, message, ...args) {
    if (!this.debug && level !== "error") return;
    
    const timestamp = globalThis.Temporal?.Now?.instant()?.toString() ?? new Date().toISOString();
    const prefix = `[${timestamp}] [KinopioHub]`;
    
    const logActions = {
      error: () => console.error(`${prefix} ERROR:`, message, ...args),
      warn: () => console.warn(`${prefix} WARN:`, message, ...args),
      info: () => console.info(`${prefix} INFO:`, message, ...args),
      default: () => console.log(`${prefix} DEBUG:`, message, ...args)
    };
    
    (logActions[level] ?? logActions.default)();
  }

  /**
   * Gets or creates a new scope for variable management
   * @param {string} scopeName - Name of the scope
   * @returns {Scope} The scope instance
   */
  getScope(scopeName) {
    return this.#scopes.get(scopeName) ?? (() => {
      const scope = new Scope(this, scopeName);
      this.#scopes.set(scopeName, scope);
      this.#log("debug", `New scope: ${scopeName}`);
      return scope;
    })();
  }

  // Update connection state
  async #setState(newState) {
    if (this.state === newState) return;
    
    const oldState = this.state;
    this.state = newState;
    this.isConnected = newState === "connected";
    
    this.#log("info", `State: ${oldState} -> ${newState}`);
    
    try {
      event.emit(KINOPIO_STATE_EVENT, newState);
    } catch (error) {
      this.#log("error", "Failed to emit state event:", error);
    }
  }

  /**
   * Connects to the NATS server with infinite retry
   * @returns {Promise<void>} Resolves when connected
   * @throws {Error} If connection fails and autoRetry is disabled
   */
  async connect() {
    if (this.state === "connected") {
      this.#log("debug", "Connection exists");
      return;
    }

    if (this.#connectionPromise) {
      this.#log("debug", "Connecting in progress");
      return this.#connectionPromise;
    }

    this.#connectionPromise = this.#doConnect();
    
    try {
      await this.#connectionPromise;
    } catch (error) {
      // Only throw if autoRetry is disabled, otherwise #doConnect will keep retrying
      if (this.#options.autoRetry === false) {
        throw error;
      }
      // If autoRetry is enabled, the error should not reach here due to infinite retry loop
      this.#log("warn", "Unexpected error in connect() with autoRetry enabled:", error);
    } finally {
      this.#connectionPromise = null;
    }
  }

  // Establish NATS connection with infinite retry
  async #doConnect() {
    if (this.state === "connecting") return;
    
    await this.#setState("connecting");
    
    while (true) {
      let timeoutId = null;
      
      try {
        this.#retryAttempt++;
        this.#log("info", `Connecting to NATS (attempt ${this.#retryAttempt})`, this.#options.servers);
        
        const connectPromise = wsconnect(this.#options);
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = this.#createTimer(() => {
            reject(new Error("NATS connection timeout"));
          }, this.#options.timeout || 10000);
        });
        
        this.#nats = await Promise.race([connectPromise, timeoutPromise]);
        
        if (timeoutId) this.#clearTimer(timeoutId);
        
        await this.#verifyConnection();
        this.#startHealthCheck();
        await this.#setState("connected");
        
        // Reset retry state on successful connection
        this.#retryAttempt = 0;
        this.#currentRetryDelay = 0;
        
        this.#log("info", "NATS connected successfully");
        return;
        
      } catch (error) {
        if (timeoutId) this.#clearTimer(timeoutId);
        
        this.#log("error", `Connection attempt ${this.#retryAttempt} failed:`, error.message);
        
        // Check if auto-retry is disabled
        if (this.#options.autoRetry === false) {
          await this.#setState("error");
          throw error;
        }
        
        // Calculate retry delay with exponential backoff + full jitter
        if (this.#retryAttempt === 1) {
          this.#currentRetryDelay = this.#options.retryDelay;
        } else {
          this.#currentRetryDelay = Math.min(
            this.#currentRetryDelay * this.#options.retryBackoffFactor,
            this.#options.maxRetryDelay
          );
        }
        // Full jitter: random(0, baseDelay)
        const jitter = Math.floor(Math.random() * this.#currentRetryDelay);
        this.#log("info", `Will retry in ${jitter}ms...`);
        
        // Wait before retry
        await new Promise(resolve => 
          this.#createTimer(resolve, jitter)
        );
        
        // Continue the retry loop
      }
    }
  }

  // Verify connection is working
  async #verifyConnection() {
    if (!this.#nats) throw new Error("No NATS connection");
    
    try {
      this.#nats.publish("_test.connection", new Uint8Array(0));
      this.#log("debug", "Connection verified");
    } catch (error) {
      this.#log("error", "Verification failed", error);
      throw new Error("Connection verification failed");
    }
  }

  /**
   * Waits for connection to be established
   * @param {number} [timeoutMs=10000] - Connection timeout in milliseconds
   * @returns {Promise<void>} Resolves when connected
   * @throws {Error} If connection fails or times out
   */
  async connected(timeoutMs = 10000) {
    if (this.state === "connected") return;
    
    const createPromise = () => {
      if (globalThis.Promise?.withResolvers) {
        return globalThis.Promise.withResolvers();
      }
      
      let resolve, reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };
    
    const { promise, resolve, reject } = createPromise();
    
    const timeoutId = this.#createTimer(() => {
      cleanup();
      reject(new Error(`Connection timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    let eventCleanup = null;
    
    const cleanup = () => {
      this.#clearTimer(timeoutId);
      eventCleanup?.();
    };

    const checkState = () => {
      switch (this.state) {
        case "connected":
          cleanup();
          resolve();
          return true;
        case "error":
          cleanup();
          reject(new Error("Connection failed"));
          return true;
        default:
          return false;
      }
    };
    
    if (checkState()) return promise;
    
    try {
      const handleStateChange = (newState) => {
        if (newState === "connected") {
          cleanup();
          resolve();
        } else if (newState === "error") {
          cleanup();
          reject(new Error("Connection failed"));
        }
      };
      
      event.on("kinopio.state", handleStateChange);
      eventCleanup = () => event.off("kinopio.state", handleStateChange);
      
    } catch (error) {
      this.#log("warn", "Using polling fallback", error);
      const poll = () => {
        if (!checkState()) {
          this.#createTimer(poll, 100);
        }
      };
      this.#createTimer(poll, 100);
    }
    
    return promise;
  }

  /**
   * Reconnects to the NATS server
   * @returns {Promise<void>} Resolves when reconnected
   * @throws {Error} If reconnection fails
   */
  async reconnect() {
    this.#log("info", "Reconnecting");
    
    try {
      await this.#cleanup();
      await this.connect();
    } catch (error) {
      this.#log("error", "Reconnect failed", error);
      await this.#setState("error");
      throw error;
    }
  }

  // Clean up resources
  async #cleanup() {
    this.#healthCheckActive = false;
    this.#clearAllTimers();
    
    if (this.#nats) {
      try {
        await this.#nats.drain();
      } catch (error) {
        this.#log("warn", "Drain failed during cleanup:", error);
        try {
          await this.#nats.close();
        } catch (closeError) {
          this.#log("warn", "Close failed during cleanup:", closeError);
        }
      }
      this.#nats = null;
    }
    
    await this.#setState("disconnected");
  }

  // Start health monitoring
  #startHealthCheck() {
    if (this.#healthCheckActive) return;
    this.#healthCheckActive = true;
    
    this.#runHealthCheck().catch(error => {
      this.#log("error", "Health check failed:", error);
    });
  }

  // Monitor connection health
  async #runHealthCheck() {
    try {
      for await (const status of this.#nats.status()) {
        if (!this.#healthCheckActive) break;
        
        const stateMap = {
          reconnect: "connected",
          disconnect: "disconnected", 
          reconnecting: "connecting"
        };
        
        const newState = stateMap[status.type];
        if (newState) {
          await this.#setState(newState);
        }
      }
    } catch (error) {
      if (this.#healthCheckActive) {
        this.#log("error", "Health check error:", error);
        await this.#setState("error");
      }
    }
  }

  /**
   * Sends a request and waits for response
   * @param {string} subject - Subject to send request to
   * @param {*} data - Data to send
   * @param {Object} [options={}] - Request options
   * @param {number} [options.timeout=5000] - Request timeout in milliseconds
   * @returns {Promise<*>} Response data
   * @throws {Error} If request fails or times out
   */
  async request(subject, data, options = {}) {
    await this.connected();
    
    const timeout = options.timeout || 5000;
    
    try {
      const message = this.#serializeData(data);
      this.#log("debug", `Sending request to ${subject}`, { data, timeout });
      
      const response = await this.#nats.request(subject, message, { timeout });
      const responseData = this.#deserializeData(response.data);
      
      this.#log("debug", `Received response from ${subject}`, responseData);
      return responseData;
      
    } catch (error) {
      this.#log("error", `Request failed for ${subject}:`, error);
      throw error;
    }
  }

  // Serialize data for transmission (pluggable codec with JSON replacer)
  #serializeData(data) {
    if (data === null || data === undefined) {
      return new Uint8Array(0);
    }
    
    if (data instanceof Uint8Array) {
      return data;
    }
    
    if (typeof data === "string") {
      return this.textEncoder.encode(data);
    }
    
    if (this.#options.codec?.encode) {
      try {
        return this.#options.codec.encode(data);
      } catch (error) {
        this.#log("warn", `Custom codec.encode failed, fallback to JSON:`, error);
      }
    }
    
    try {
      const jsonString = JSON.stringify(data, this.#options.jsonReplacer);
      return this.textEncoder.encode(jsonString);
    } catch (error) {
      this.#log("warn", `Serialization failed, using string conversion:`, error);
      return this.textEncoder.encode(String(data));
    }
  }

  // Deserialize received data (pluggable codec with JSON reviver)
  #deserializeData(uint8Array) {
    if (!uint8Array || uint8Array.length === 0) {
      return null;
    }
    
    if (this.#options.codec?.decode) {
      try {
        return this.#options.codec.decode(uint8Array);
      } catch (error) {
        this.#log("warn", `Custom codec.decode failed, fallback to text/JSON:`, error);
      }
    }
    
    try {
      const text = this.textDecoder.decode(uint8Array);
      
      try {
        return JSON.parse(text, this.#options.jsonReviver);
      } catch {
        return text;
      }
    } catch (error) {
      this.#log("warn", `Deserialization failed:`, error);
      return uint8Array;
    }
  }

  // Public getters for internal state
  get nats() { return this.#nats; }
  get subscriptions() { return this.#subscriptions; }
  get healthCheckActive() { return this.#healthCheckActive; }
  
  /**
   * Logs a message with timestamp
   * @param {"error"|"warn"|"info"|"debug"} level - Log level
   * @param {string} message - Message to log
   * @param {...*} args - Additional arguments
   */
  log(level, message, ...args) {
    return this.#log(level, message, ...args);
  }
  
  /**
   * Subscribe to state changes. Returns an unsubscribe function.
   * @param {(state: string) => void} listener
   * @returns {() => void}
   */
  onStateChange(listener) {
    event.on(KINOPIO_STATE_EVENT, listener);
    return () => event.off(KINOPIO_STATE_EVENT, listener);
  }
  
  /**
   * Unsubscribe a state change listener
   * @param {(state: string) => void} listener
   */
  offStateChange(listener) {
    event.off(KINOPIO_STATE_EVENT, listener);
  }
  
  /**
   * Serializes data for transmission
   * @param {*} data - Data to serialize
   * @returns {Uint8Array} Serialized data
   */
  serializeData(data) {
    return this.#serializeData(data);
  }
  
  /**
   * Deserializes received data
   * @param {Uint8Array} uint8Array - Data to deserialize
   * @returns {*} Deserialized data
   */
  deserializeData(uint8Array) {
    return this.#deserializeData(uint8Array);
  }

  /**
   * Cleans up resources and disconnects
   * @returns {Promise<void>} Resolves when cleanup is complete
   */
  async dispose() {
    this.#log("info", "Disposing");
    this.#healthCheckActive = false;
    
    // ES2024: Enhanced Map iteration for cleanup
    for (const [key, subscription] of this.#subscriptions) {
      try {
        subscription.unsubscribe();
      } catch (error) {
        this.#log("warn", `Failed to unsubscribe ${key}:`, error);
      }
    }
    this.#subscriptions.clear();
    
    // Cleanup scopes
    for (const [, scope] of this.#scopes) {
      scope.dispose();
    }
    this.#scopes.clear();
    
    await this.#cleanup();
  }
}

/**
 * Scope - Manages a group of variables within a namespace
 * 
 * @class Scope
 * @description A scope represents a namespace for variables, allowing organization
 * of related variables under a common prefix. Variables in a scope share the same
 * prefix in their NATS subjects.
 * 
 * @example
 * ```js
 * // Get a scope
 * const userScope = hub.getScope("users");
 * 
 * // Get variables in the scope
 * const onlineUsers = userScope.getVariable("online");
 * const userCount = userScope.getVariable("count");
 * ```
 */
class Scope {
  #hub;
  #scopeName;
  #variables = new Map();
  
  /**
   * Creates a new Scope instance
   * @param {KinopioHub} hub - The KinopioHub instance
   * @param {string} scopeName - Name of the scope
   */
  constructor(hub, scopeName) {
    this.#hub = hub;
    this.#scopeName = scopeName;
    
    return new Proxy(this, {
      get: (target, prop) => {
        if (prop in target || typeof prop === "symbol") {
          const value = target[prop];
          // Bind methods to preserve 'this' context and private field access
          if (typeof value === 'function') {
            return value.bind(target);
          }
          return value;
        }
        return target.getVariable(prop);
      }
    });
  }

  /**
   * Gets or creates a variable in this scope
   * @param {string} varName - Name of the variable
   * @returns {Variable} The variable instance
   */
  getVariable(varName) {
    return this.#variables.get(varName) ?? (() => {
      const variable = new Variable(this.#hub, this.#scopeName, varName);
      this.#variables.set(varName, variable);
      return variable;
    })();
  }

  /**
   * Cleans up all variables in this scope
   */
  dispose() {
    for (const [, variable] of this.#variables) {
      variable.dispose();
    }
    this.#variables.clear();
  }
}

/**
 * Variable - Handles pub/sub operations for a specific topic
 * 
 * @class Variable
 * @description A variable represents a specific topic in the NATS system,
 * providing methods for publishing, subscribing, and request/reply patterns.
 * Each variable automatically tracks its latest value and supports deduplication
 * of messages.
 * 
 * @example
 * ```js
 * // Get a variable
 * const counter = scope.getVariable("counter");
 * 
 * // Publish value
 * await counter.pub(42);
 * 
 * // Subscribe to changes
 * await counter.sub(value => {
 *   console.log("Counter changed:", value);
 * });
 * 
 * // Make request
 * const response = await counter.req({ action: "increment" });
 * 
 * // Set up service
 * await counter.serve(async (request) => {
 *   if (request.action === "increment") {
 *     return { value: currentValue + 1 };
 *   }
 * });
 * ```
 */
class Variable {
  #hub;
  #scopeName;
  #varName;
  #subject;
  #lastPublishedMessage = null;
  #subscriptionCache = new Map();
  #latestValue = null;
  #valueSubscription = null;
  #hasReceivedValue = false;
  #serviceSubscription = null;
  #serviceHandler = null;
  
  /**
   * Creates a new Variable instance
   * @param {KinopioHub} hub - The KinopioHub instance
   * @param {string} scopeName - Name of the scope
   * @param {string} varName - Name of the variable
   */
  constructor(hub, scopeName, varName) {
    this.#hub = hub;
    this.#scopeName = scopeName;
    this.#varName = varName;
    this.#subject = `${scopeName}.${varName}`;
    
    this.#startValueTracking();
    
    // ES2024: Enhanced proxy with readonly value property
    return new Proxy(this, {
      get: (target, prop) => {
        if (prop === 'value') {
          return target.#latestValue;
        }
        if (prop in target || typeof prop === "symbol") {
          const value = target[prop];
          // Bind methods to preserve 'this' context and private field access
          if (typeof value === 'function') {
            return value.bind(target);
          }
          return value;
        }
        return target[prop];
      },
      set: (target, prop, value) => {
        if (prop === 'value') {
          target.#hub.log("warn", `Cannot set readonly property 'value' on Variable ${target.#subject}`);
          return true;
        }
        target[prop] = value;
        return true;
      }
    });
  }

  // Track variable value changes with retry
  async #startValueTracking() {
    try {
      await this.#hub.connected();
      
      if (!this.#hub.nats) {
        this.#hub.log("debug", `NATS connection not available for ${this.#subject}, waiting...`);
        setTimeout(() => this.#startValueTracking(), 1000);
        return;
      }
      
      const subscription = this.#hub.nats.subscribe(this.#subject, { max: -1 });
      this.#valueSubscription = subscription;
      
      this.#processValueMessages(subscription);
      this.#hub.log("debug", `Value tracking started: ${this.#subject}`);
    } catch (error) {
      this.#hub.log("debug", `Value tracking failed: ${this.#subject}, will retry...`, error.message);
      // Retry after delay on error
      setTimeout(() => this.#startValueTracking(), 2000);
    }
  }

  // Ensure NATS connection is available
  async #ensureNatsConnection(operation = "operation") {
    const maxRetries = 3;
    let retryCount = 0;
    
    while (retryCount < maxRetries) {
      await this.#hub.connected();
      if (this.#hub.nats) return;
      
      this.#hub.log("warn", `NATS connection not available for ${operation} on ${this.#subject}, retrying...`);
      retryCount++;
      
      if (retryCount >= maxRetries) {
        throw new Error(`NATS connection not available for ${operation} on ${this.#subject}`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 100 * retryCount));
    }
  }

  // Process incoming value updates
  async #processValueMessages(subscription) {
    try {
      for await (const message of subscription) {
        try {
          const data = this.#deserializeData(message.data);
          this.#latestValue = data;
          this.#hasReceivedValue = true;
          this.#hub.log("debug", `Value updated: ${this.#subject}`, data);
        } catch (error) {
          this.#hub.log("error", `Value error: ${this.#subject}`, error);
        }
      }
    } catch (error) {
      if (this.#hub.healthCheckActive) {
        this.#hub.log("error", `Value tracking iterator error for ${this.#subject}:`, error);
      }
    }
  }

  /**
   * Publishes a value to this variable's subject
   * @param {*} data - Data to publish
   * @param {Object} [options={}] - Publish options
   * @returns {Promise<void>} Resolves when published
   * @throws {Error} If publish fails
   */
  async pub(data, options = {}) {
    await this.#ensureNatsConnection("publishing");
    
    try {
      const message = this.#serializeData(data);
      
      if (this.#isDuplicateMessage(message)) {
        this.#hub.log("debug", `Skipped duplicate: ${this.#subject}`);
        return;
      }
      
      this.#hub.nats.publish(this.#subject, message, options);
      this.#lastPublishedMessage = message;
      this.#latestValue = data;
      this.#hasReceivedValue = true;
      
      this.#hub.log("debug", `Published: ${this.#subject}`, { message, options });
      
    } catch (error) {
      this.#hub.log("error", `Publish failed: ${this.#subject}`, error);
      throw error;
    }
  }

  /**
   * Subscribes to updates of this variable
   * @param {Function} callback - Callback function(data, message)
   * @param {Object} [options={}] - Subscription options
   * @param {string} [options.queue] - Queue group name
   * @param {number} [options.max] - Max messages to receive
   * @returns {Promise<Subscription>} Subscription object
   * @throws {Error} If subscription fails
   */
  async sub(callback, options = {}) {
    await this.#ensureNatsConnection("subscription");
    
    const subKey = this.#generateSubscriptionKey(options);
    
    const existing = this.#subscriptionCache.get(subKey);
    if (existing) {
      this.#hub.log("debug", `Reusing sub: ${this.#subject}`);
      return existing;
    }

    try {
      const subscription = this.#hub.nats.subscribe(this.#subject, options);
      const originalUnsubscribe = subscription.unsubscribe?.bind(subscription);
      // wrap unsubscribe to cleanup caches
      subscription.unsubscribe = () => {
        try { originalUnsubscribe?.(); } finally {
          this.#subscriptionCache.delete(subKey);
          this.#hub.subscriptions.delete(`${this.#subject}_${subKey}`);
        }
      };
      
      this.#subscriptionCache.set(subKey, subscription);
      this.#hub.subscriptions.set(`${this.#subject}_${subKey}`, subscription);
      
      this.#processMessages(subscription, callback);
      
      this.#hub.log("debug", `Subscribed: ${this.#subject}`, options);
      return subscription;
      
    } catch (error) {
      this.#hub.log("error", `Sub failed: ${this.#subject}`, error);
      throw error;
    }
  }

  // Process subscription messages
  async #processMessages(subscription, callback) {
    try {
      for await (const message of subscription) {
        // ES2024: Use structured error handling
        const processMessage = async () => {
          const data = this.#deserializeData(message.data);
          await callback(data, message);
        };
        
        await processMessage().catch(error => 
          this.#hub.log("error", `Msg error: ${this.#subject}`, error)
        );
      }
    } catch (error) {
      if (this.#hub.healthCheckActive) {
        this.#hub.log("error", `Iterator error: ${this.#subject}`, error);
      }
    }
  }

  /**
   * Sends a request and awaits response
   * @param {*} data - Request data
   * @param {Object} [options={}] - Request options
   * @param {number} [options.timeout=5000] - Request timeout in milliseconds
   * @returns {Promise<*>} Response data
   * @throws {Error} If request fails or times out
   */
  async req(data, options = {}) {
    await this.#ensureNatsConnection("request");
    
    const timeout = options.timeout || 5000;
    
    try {
      const message = this.#serializeData(data);
      const response = await this.#hub.nats.request(this.#subject, message, { timeout });
      
      this.#hub.log("debug", `Request sent to ${this.#subject}`, { message, timeout });
      return this.#deserializeData(response.data);
      
    } catch (error) {
      this.#hub.log("error", `Request failed for ${this.#subject}:`, error);
      throw error;
    }
  }

  /**
   * Sets up a request handler service
   * @param {Function} handler - Handler function(request, message)
   * @param {Object} [options={}] - Service options
   * @param {string} [options.queue] - Queue group name
   * @returns {Promise<Subscription>} Service subscription
   * @throws {Error} If service setup fails
   */
  async serve(handler, options = {}) {
    await this.#ensureNatsConnection("service");
    
    if (this.#serviceSubscription) {
      this.#hub.log("debug", `Stopping service: ${this.#subject}`);
      try {
        this.#serviceSubscription.unsubscribe();
        this.#hub.subscriptions.delete(`${this.#subject}_service`);
      } catch (error) {
        this.#hub.log("warn", `Failed to stop existing service:`, error);
      }
    }
    
    try {
      this.#serviceHandler = handler;
      
      const subscribeOptions = {
        ...options,
        queue: options.queue || `${this.#subject}.service`
      };
      
      this.#serviceSubscription = this.#hub.nats.subscribe(this.#subject, subscribeOptions);
      const originalUnsubscribe = this.#serviceSubscription.unsubscribe?.bind(this.#serviceSubscription);
      this.#serviceSubscription.unsubscribe = () => {
        try { originalUnsubscribe?.(); } finally {
          this.#hub.subscriptions.delete(`${this.#subject}_service`);
        }
      };
      this.#hub.subscriptions.set(`${this.#subject}_service`, this.#serviceSubscription);
      
      this.#processServiceRequests(this.#serviceSubscription, handler);
      
      this.#hub.log("debug", `Service started: ${this.#subject}`, subscribeOptions);
      return this.#serviceSubscription;
      
    } catch (error) {
      this.#hub.log("error", `Service failed: ${this.#subject}`, error);
      throw error;
    }
  }

  // Process incoming service requests
  async #processServiceRequests(subscription, handler) {
    try {
      for await (const message of subscription) {
        try {
          const requestData = this.#deserializeData(message.data);
          this.#hub.log("debug", `Received service request for ${this.#subject}:`, requestData);
          
          let responseData;
          try {
            responseData = await handler(requestData, message);
          } catch (handlerError) {
            this.#hub.log("error", `Handler error: ${this.#subject}`, handlerError);
            responseData = { 
              error: true, 
              message: handlerError.message || 'Service handler error' 
            };
          }
          
          if (message.reply) {
            const responseMessage = this.#serializeData(responseData);
            this.#hub.nats.publish(message.reply, responseMessage);
            this.#hub.log("debug", `Sent service response for ${this.#subject}:`, responseData);
          }
          
        } catch (error) {
          this.#hub.log("error", `Request error: ${this.#subject}`, error);
        }
      }
    } catch (error) {
      if (this.#hub.healthCheckActive) {
        this.#hub.log("error", `Service error: ${this.#subject}`, error);
      }
    }
  }

  // Helper methods
  #generateSubscriptionKey(options) {
    const keyParts = [
      options.queue || "",
      options.max || "",
      JSON.stringify(options.headers || {})
    ];
    return keyParts.join("_");
  }

  #serializeData(data) {
    return this.#hub.serializeData(data);
  }

  #deserializeData(uint8Array) {
    return this.#hub.deserializeData(uint8Array);
  }

  #isDuplicateMessage(message) {
    if (!this.#lastPublishedMessage) return false;
    
    if (message.length !== this.#lastPublishedMessage.length) return false;
    
    return message.every((byte, index) => byte === this.#lastPublishedMessage[index]);
  }

  /**
   * Cleans up subscriptions and resources
   */
  dispose() {
    [this.#valueSubscription, this.#serviceSubscription]
      .filter(Boolean)
      .forEach(sub => {
        try {
          sub.unsubscribe();
        } catch (error) {
          this.#hub.log("warn", "Cleanup failed", error);
        }
      });
    
    if (this.#serviceSubscription) {
      this.#hub.subscriptions.delete(`${this.#subject}_service`);
      this.#serviceSubscription = null;
      this.#serviceHandler = null;
    }
    
    for (const [key, subscription] of this.#subscriptionCache) {
      try {
        subscription.unsubscribe();
        this.#hub.subscriptions.delete(`${this.#subject}_${key}`);
      } catch (error) {
        this.#hub.log("warn", `Cleanup failed: ${key}`, error);
      }
    }
    
    this.#subscriptionCache.clear();
    this.#resetState();
  }

  // Reset variable state
  #resetState() {
    this.#lastPublishedMessage = null;
    this.#latestValue = null;
    this.#hasReceivedValue = false;
    this.#valueSubscription = null;
  }
}

export default KinopioHub;
