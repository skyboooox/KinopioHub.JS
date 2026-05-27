export type KinopioState = "disconnected" | "connecting" | "connected" | "error";
export type ServerSelectionMode = "ordered" | "random" | "latency";

export interface KinopioCodec {
  encode(data: unknown): Uint8Array;
  decode(bytes: Uint8Array): unknown;
}

export interface KinopioDiscoveryOptions {
  enabled?: boolean;
  manifestUrl?: string;
  backgroundLocalProbe?: boolean;
  localSwitchTimeoutMs?: number;
  cacheTtlMs?: number;
}

export type KinopioAutoLeafOptions = Omit<import("./leaf").AutoLeafOptions, "discoveryNamespace"> & {
  discoveryNamespace?: import("./leaf").AutoLeafOptions["discoveryNamespace"];
  enabled?: boolean;
};

export interface KinopioOptions {
  debug?: boolean;
  servers?: string[];
  noEcho?: boolean;
  serverSelectionMode?: ServerSelectionMode;
  /** @deprecated Use serverSelectionMode instead. true maps to "ordered", false maps to "random". */
  noRandomize?: boolean;
  maxReconnectAttempts?: number;
  waitOnFirstConnect?: boolean;
  reconnectTimeout?: number;
  reconnectTimeWait?: number;
  pingInterval?: number;
  maxPingOut?: number;
  timeout?: number;
  healthReport?: number;
  autoConnect?: boolean;
  autoRetry?: boolean;
  retryDelay?: number;
  maxRetryDelay?: number;
  retryBackoffFactor?: number;
  discovery?: false | KinopioDiscoveryOptions;
  autoLeaf?: boolean | KinopioAutoLeafOptions;
  codec?: KinopioCodec;
  jsonReplacer?: (this: unknown, key: string, value: unknown) => unknown;
  jsonReviver?: (this: unknown, key: string, value: unknown) => unknown;
}

export interface Subscription {
  unsubscribe(): void;
  [Symbol.asyncIterator](): AsyncIterator<any>;
}

export declare const KINOPIO_STATE_EVENT: "kinopio.state";

export default class KinopioHub {
  constructor(options?: KinopioOptions);

  readonly isBrowser: boolean;
  readonly state: KinopioState;
  readonly isConnected: boolean;

  connect(): Promise<void>;
  connected(timeoutMs?: number): Promise<void>;
  reconnect(): Promise<void>;
  request(subject: string, data: unknown, options?: { timeout?: number }): Promise<unknown>;
  dispose(): Promise<void>;

  getScope(scopeName: string): Scope;

  log(level: "error" | "warn" | "info" | "debug", message: string, ...args: unknown[]): void;
  serializeData(data: unknown): Uint8Array;
  deserializeData(uint8Array: Uint8Array): unknown;

  onStateChange(listener: (state: KinopioState) => void): () => void;
  offStateChange(listener: (state: KinopioState) => void): void;
}

export class Scope {
  constructor(hub: KinopioHub, name: string);
  getVariable<T = unknown>(key: string): Variable<T>;
  dispose(): void;
}

export class Variable<T = unknown> {
  value: T | null;
  readonly subject: string;

  pub(data: T, options?: Record<string, unknown>): Promise<void>;
  sub(callback: (data: T, message: unknown) => unknown | Promise<unknown>, options?: { queue?: string; max?: number }): Promise<Subscription>;
  req<R = unknown>(data: unknown, options?: { timeout?: number }): Promise<R>;
  serve(handler: (request: unknown, message: unknown) => unknown | Promise<unknown>, options?: { queue?: string }): Promise<Subscription>;
  dispose(): void;
}
