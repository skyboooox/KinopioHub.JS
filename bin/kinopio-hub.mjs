#!/usr/bin/env node

import { enableAutoLeaf, startLeafNode } from "../leaf.mjs";

const HELP_TEXT = `KinopioHub CLI

Usage:
  kinopio-hub leaf start --discovery-namespace <name> [options]
  kinopio-hub leaf auto --discovery-namespace <name> [options]
  kinopio-hub --help

Commands:
  leaf start   Start a manual local leaf runtime and keep it running until SIGINT/SIGTERM.
  leaf auto    Join the auto-election agent and keep it running until SIGINT/SIGTERM.

Common options:
  --discovery-namespace <name>   Required discovery namespace shared by the local leaf domain.
  --backbone-server <url>        Repeatable upstream NATS/leaf remote URL.
  --advertised-hostname <name>   Override the hostname advertised to browsers and peers.
  --node-id <id>                 Override the stable nodeId cache for auto mode or status metadata.
  --cache-dir <path>             Override the user cache root used for runtime assets.
  --binary-path <path>           Use an explicit nats-server binary instead of the cached one.
  --runtime-dir <path>           Place the temporary runtime directory under the given parent.
  --lan-bind-address <ip>        Override the LAN bind address used for WSS and discovery listeners.
  --client-port <port>           Fixed local NATS client port.
  --websocket-port <port>        Fixed local WSS port.
  --discovery-port <port>        Fixed local discovery HTTPS port.
  --monitor-port <port>          Fixed local monitoring port.
  --tls-cert-file <path>         Use an explicit PEM certificate instead of the generated local CA flow.
  --tls-key-file <path>          Use an explicit PEM private key instead of the generated local CA flow.
  --json                         Print the initial status snapshot as JSON only.
  --help                         Show this help text.

Auto-only options:
  --leader-missing-grace-ms <n>  Override the failover grace window before a new leader is elected.

Examples:
  kinopio-hub leaf start --discovery-namespace studio
  kinopio-hub leaf auto --discovery-namespace studio --backbone-server nats://upstream.example.com:7422
`;

function printHelp() {
  console.log(HELP_TEXT);
}

function requireFlagValue(args, index, flag) {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function setNestedOption(target, key, nestedKey, value) {
  if (!target[key]) {
    target[key] = {};
  }
  target[key][nestedKey] = value;
}

function cleanupLeafOptions(options) {
  if (Array.isArray(options.backboneServers) && options.backboneServers.length === 0) {
    delete options.backboneServers;
  }
  if (options.ports && Object.keys(options.ports).length === 0) {
    delete options.ports;
  }
  if (options.tls && Object.keys(options.tls).length === 0) {
    delete options.tls;
  }
  return options;
}

function parseLeafOptions(args) {
  const options = {
    backboneServers: [],
  };
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    switch (argument) {
      case "--help":
        return { help: true };
      case "--json":
        json = true;
        break;
      case "--discovery-namespace":
        options.discoveryNamespace = requireFlagValue(args, ++index, argument);
        break;
      case "--backbone-server":
        options.backboneServers.push(requireFlagValue(args, ++index, argument));
        break;
      case "--advertised-hostname":
        options.advertisedHostname = requireFlagValue(args, ++index, argument);
        break;
      case "--node-id":
        options.nodeId = requireFlagValue(args, ++index, argument);
        break;
      case "--cache-dir":
        options.cacheDir = requireFlagValue(args, ++index, argument);
        break;
      case "--binary-path":
        options.binaryPath = requireFlagValue(args, ++index, argument);
        break;
      case "--runtime-dir":
        options.runtimeDir = requireFlagValue(args, ++index, argument);
        break;
      case "--lan-bind-address":
        options.lanBindAddress = requireFlagValue(args, ++index, argument);
        break;
      case "--client-port":
        setNestedOption(options, "ports", "client", parsePositiveInteger(requireFlagValue(args, ++index, argument), argument));
        break;
      case "--websocket-port":
        setNestedOption(options, "ports", "websocket", parsePositiveInteger(requireFlagValue(args, ++index, argument), argument));
        break;
      case "--discovery-port":
        setNestedOption(options, "ports", "discovery", parsePositiveInteger(requireFlagValue(args, ++index, argument), argument));
        break;
      case "--monitor-port":
        setNestedOption(options, "ports", "monitor", parsePositiveInteger(requireFlagValue(args, ++index, argument), argument));
        break;
      case "--tls-cert-file":
        setNestedOption(options, "tls", "certFile", requireFlagValue(args, ++index, argument));
        break;
      case "--tls-key-file":
        setNestedOption(options, "tls", "keyFile", requireFlagValue(args, ++index, argument));
        break;
      case "--leader-missing-grace-ms":
        options.leaderMissingGraceMs = parsePositiveInteger(requireFlagValue(args, ++index, argument), argument);
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  return {
    help: false,
    json,
    options: cleanupLeafOptions(options),
  };
}

function renderStatusSnapshot(label, status, jsonOnly) {
  const payload = JSON.stringify(status, null, 2);
  if (jsonOnly) {
    console.log(payload);
    return;
  }

  console.log(`${label} is ready. Press Ctrl+C to stop.\n`);
  console.log(payload);
}

async function waitForTermination(stop, label, jsonOnly) {
  await new Promise((resolve, reject) => {
    let stopping = false;
    const keepAliveTimer = setInterval(() => {}, 60_000);

    const cleanup = () => {
      clearInterval(keepAliveTimer);
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
    };

    const handleSignal = (signal) => {
      if (stopping) {
        return;
      }
      stopping = true;

      cleanup();
      Promise.resolve()
        .then(() => stop())
        .then(() => {
          if (!jsonOnly) {
            console.error(`Received ${signal}; ${label} stopped.`);
          }
          resolve();
          process.exit(0);
        })
        .catch((error) => {
          reject(error);
          process.exit(1);
        });
    };

    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
  });
}

async function runLeafCommand(mode, parsed) {
  if (parsed.help) {
    printHelp();
    return;
  }

  if (!parsed.options.discoveryNamespace) {
    throw new Error("--discovery-namespace is required");
  }

  if (mode === "start" && parsed.options.leaderMissingGraceMs !== undefined) {
    throw new Error("--leader-missing-grace-ms is only supported by \"kinopio-hub leaf auto\"");
  }

  if (mode === "start") {
    const handle = await startLeafNode(parsed.options);
    renderStatusSnapshot("Local leaf runtime", handle.status(), parsed.json);
    await waitForTermination(() => handle.stop(), "local leaf runtime", parsed.json);
    return;
  }

  const handle = await enableAutoLeaf(parsed.options);
  renderStatusSnapshot("Auto leaf agent", handle.status(), parsed.json);
  await waitForTermination(() => handle.stop(), "auto leaf agent", parsed.json);
}

async function main(argv) {
  if (argv.length === 0 || argv.includes("--help")) {
    printHelp();
    return;
  }

  const [namespace, command, ...rest] = argv;
  if (namespace !== "leaf" || (command !== "start" && command !== "auto")) {
    throw new Error("Expected \"kinopio-hub leaf start\" or \"kinopio-hub leaf auto\"");
  }

  const parsed = parseLeafOptions(rest);
  await runLeafCommand(command, parsed);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
