import {
  createUnsupportedPlatformError,
  ensureNatsServerBinary,
} from "../leaf-runtime.mjs";

if (process.env.KINOPIO_SKIP_NATS_SERVER_DOWNLOAD === "1") {
  console.log("[kinopio-hub] skipping bundled nats-server download because KINOPIO_SKIP_NATS_SERVER_DOWNLOAD=1");
  process.exit(0);
}

try {
  await ensureNatsServerBinary();
} catch (error) {
  if (error?.code === "KINOPIO_UNSUPPORTED_NATS_SERVER_PLATFORM") {
    console.warn(`[kinopio-hub] ${error.message}`);
    process.exit(0);
  }

  const unsupported = createUnsupportedPlatformError();
  if (error?.message === unsupported.message) {
    console.warn(`[kinopio-hub] ${error.message}`);
    process.exit(0);
  }

  console.warn("[kinopio-hub] postinstall could not prefetch nats-server.");
  console.warn("[kinopio-hub] startLeafNode() will retry on demand.");
  console.warn(error?.stack || String(error));
}
