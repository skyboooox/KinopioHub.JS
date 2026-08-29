export type LeafAgentState =
  | "discovering"
  | "following-leader"
  | "leader-missing-grace"
  | "electing"
  | "starting-leaf"
  | "leader"
  | "stopped";

export interface LeafDiscoveryManifest {
  version: string;
  expiresAt: string;
  leaderEpoch: number;
  advertisedHostname: string;
  websocketUrl: string;
  wssUrl: string;
  fallbackServers: string[];
  bridgeState?: "connecting" | "connected" | "disconnected" | "error";
  backboneRttMs: number | null;
  discoveryUrl?: string;
  leaseExpiresAt?: string;
  nodeId?: string;
  discoveryNamespace?: string;
  isLeader?: boolean;
  candidateRole?: "follower" | "candidate" | "leader" | "stopped";
}

export interface LeafNodePorts {
  client?: number;
  websocket?: number;
  discovery?: number;
  monitor?: number;
}

export interface LeafNodeTlsOptions {
  certFile?: string;
  keyFile?: string;
}

export interface LeafNodeOptions {
  discoveryNamespace: string;
  backboneServers?: string[];
  webSocketTls?: boolean;
  advertisedHostname?: string;
  nodeId?: string;
  cacheDir?: string;
  binaryPath?: string;
  runtimeDir?: string;
  lanBindAddress?: string;
  ports?: LeafNodePorts;
  tls?: LeafNodeTlsOptions;
}

export interface AutoLeafOptions extends LeafNodeOptions {
  leaderMissingGraceMs?: number;
}

export interface LeafTrustStatus {
  state: "external" | "installed" | "skipped" | "failed";
  platform: string;
  strategy: string | null;
  detail: string | null;
  attempted: boolean;
  requiresUserAction: boolean;
}

export interface LeafTlsStatus {
  mode: "external" | "generated-ca" | "disabled";
  certFile: string | null;
  caCertFile: string | null;
  trust: LeafTrustStatus;
}

export interface LeafNodeHandle {
  readonly websocketUrl: string;
  readonly wssUrl: string;
  readonly discoveryUrl: string;
  readonly advertisedHostname: string;
  readonly clientUrl: string;
  readonly monitorUrl: string;
  status(): Readonly<{
    phase: "starting" | "ready" | "stopping" | "stopped" | "error";
    bridgeState: "connecting" | "connected" | "disconnected" | "error";
    websocketUrl: string;
    wssUrl: string;
    discoveryUrl: string;
    clientUrl: string;
    monitorUrl: string;
    runtimeVersion: string;
    binaryPath: string;
    runtimeDir: string;
    lanBindAddress: string;
    backboneServers: string[];
    ports: {
      client: number;
      websocket: number;
      discovery: number;
      monitor: number;
    };
    configFile: string;
    logFile: string;
    pidFile: string;
    storeDir: string;
    processId: number | null;
    processExitCode: number | null;
    lastError: string | null;
    outputTail: string[];
    manifest: LeafDiscoveryManifest;
    tls: LeafTlsStatus;
    [key: string]: unknown;
  }>;
  __setManifestState?(patch: Partial<LeafDiscoveryManifest>): void;
  stop(): Promise<void>;
}

export interface AutoLeafHandle {
  state(): LeafAgentState;
  role(): "follower" | "candidate" | "leader" | "stopped";
  currentLeader(): LeafDiscoveryManifest | null;
  status(): Readonly<{
    state: LeafAgentState;
    leader: LeafDiscoveryManifest | null;
    role: "follower" | "candidate" | "leader" | "stopped";
    nodeId: string;
    backboneRttMs: number | null;
    leaderEpoch: number;
    leaderMissingGraceMs: number;
    preemptionStreak: number;
    lastError: string | null;
    localLeaf: ReturnType<LeafNodeHandle["status"]> | null;
    mdnsAvailable: boolean;
    [key: string]: unknown;
  }>;
  stop(): Promise<void>;
}

export declare function startLeafNode(options: LeafNodeOptions): Promise<LeafNodeHandle>;
export declare function enableAutoLeaf(options: AutoLeafOptions): Promise<AutoLeafHandle>;
