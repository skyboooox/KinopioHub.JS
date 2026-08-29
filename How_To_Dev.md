# KinopioHub.JS Development Guide

This document provides information and guidelines needed for contributing to KinopioHub.JS development.

## Development Environment Setup

### Prerequisites

- Node.js >= 18.17.0
- A NATS server with WebSocket support (for testing)
- `openssl` in PATH if you want to exercise the phase-2 local leaf runtime without providing your own PEM files
- LAN UDP multicast plus mDNS availability if you want to exercise the phase-3 auto leaf election flow end-to-end
- Optional platform trust-store tooling if you want to exercise the phase-5 CA installation path end-to-end (`security` on macOS, `certutil` on Windows, `update-ca-certificates` on Debian-style Linux)

### Installing Dependencies

```bash
# Clone the repository
git clone git@github.com:skyboooox/KinopioHub.JS.git
cd KinopioHub.JS
npm install
```

`npm install` now performs a best-effort prefetch of the official `nats-server v2.12.7` binary for the Node-only leaf runtime. Set `KINOPIO_SKIP_NATS_SERVER_DOWNLOAD=1` if you need to skip that prefetch during local setup.

If you do not want local tests or automation runs to attempt trust-store mutation for the generated leaf CA, set `KINOPIO_SKIP_CA_TRUST_INSTALL=1`.

## Repository Layout

The root `.mjs` files are public facades. Implementation code lives under `lib/`: `lib/shared` contains browser-safe pure utilities, `lib/hub` contains the browser-safe client, and `lib/leaf` contains Node-only leaf runtime code.

Tests live under `test/` and run with `bun test`.

## Verification

```bash
npm test
npm run test:bun
bun test test/browser-discovery.test.mjs
node example/browser-discovery.mjs
node example/leaf-entrypoint.mjs
node example/auto-leaf.mjs
node ./bin/kinopio-hub.mjs --help
```

The CLI smoke path is also covered by `bun test test/cli.test.mjs`, which starts both `kinopio-hub leaf start` and `kinopio-hub leaf auto`, waits for the initial status snapshot, and then shuts them down with `SIGINT`.
