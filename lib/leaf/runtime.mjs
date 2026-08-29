import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const NATS_SERVER_VERSION = process.env.KINOPIO_NATS_SERVER_VERSION?.trim() || "2.12.7";
export const WELL_KNOWN_MANIFEST_PATH = "/.well-known/kinopio-leader.json";

const USER_AGENT = `kinopio-hub-leaf-runtime/${NATS_SERVER_VERSION}`;
const RELEASE_BASE_URL = `https://github.com/nats-io/nats-server/releases/download/v${NATS_SERVER_VERSION}`;
const SHA256SUMS_URL = `${RELEASE_BASE_URL}/SHA256SUMS`;

function emit(logger, method, ...args) {
  if (!logger || typeof logger[method] !== "function") return;
  logger[method](...args);
}

function getDefaultUserCacheRoot() {
  if (process.env.KINOPIO_LEAF_CACHE_DIR) {
    return process.env.KINOPIO_LEAF_CACHE_DIR;
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches");
  }

  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  }

  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
}

export function resolveLeafCacheRoot(customCacheDir) {
  return customCacheDir || getDefaultUserCacheRoot();
}

function createUnsupportedPlatformError(platform = process.platform, arch = process.arch) {
  const error = new Error(
    `No official nats-server asset mapping is configured for ${platform}/${arch}. ` +
    `Provide options.binaryPath or install a supported official release manually.`,
  );
  error.code = "KINOPIO_UNSUPPORTED_NATS_SERVER_PLATFORM";
  error.platform = platform;
  error.arch = arch;
  return error;
}

export function getNatsServerAssetSpec(platform = process.platform, arch = process.arch) {
  const binaryName = platform === "win32" ? "nats-server.exe" : "nats-server";

  const tarballMap = new Map([
    ["darwin:x64", `nats-server-v${NATS_SERVER_VERSION}-darwin-amd64.tar.gz`],
    ["darwin:arm64", `nats-server-v${NATS_SERVER_VERSION}-darwin-arm64.tar.gz`],
    ["linux:x64", `nats-server-v${NATS_SERVER_VERSION}-linux-amd64.tar.gz`],
    ["linux:arm64", `nats-server-v${NATS_SERVER_VERSION}-linux-arm64.tar.gz`],
    ["linux:ia32", `nats-server-v${NATS_SERVER_VERSION}-linux-386.tar.gz`],
    ["linux:arm", `nats-server-v${NATS_SERVER_VERSION}-linux-arm7.tar.gz`],
    ["freebsd:x64", `nats-server-v${NATS_SERVER_VERSION}-freebsd-amd64.tar.gz`],
  ]);
  const zipMap = new Map([
    ["win32:x64", `nats-server-v${NATS_SERVER_VERSION}-windows-amd64.zip`],
    ["win32:arm64", `nats-server-v${NATS_SERVER_VERSION}-windows-arm64.zip`],
    ["win32:ia32", `nats-server-v${NATS_SERVER_VERSION}-windows-386.zip`],
  ]);

  const key = `${platform}:${arch}`;
  if (tarballMap.has(key)) {
    return {
      assetName: tarballMap.get(key),
      archiveType: "tar.gz",
      binaryName,
      downloadUrl: `${RELEASE_BASE_URL}/${tarballMap.get(key)}`,
    };
  }

  if (zipMap.has(key)) {
    return {
      assetName: zipMap.get(key),
      archiveType: "zip",
      binaryName,
      downloadUrl: `${RELEASE_BASE_URL}/${zipMap.get(key)}`,
    };
  }

  return null;
}

export function resolveLeafBinaryInstallDir(customCacheDir) {
  const baseCacheDir = resolveLeafCacheRoot(customCacheDir);
  return path.join(baseCacheDir, "kinopio-hub", "nats-server", `v${NATS_SERVER_VERSION}`);
}

export function normalizeBackboneServerUrl(value) {
  const normalizedValue = typeof value === "string" ? value.trim() : "";
  if (!normalizedValue) {
    throw new TypeError("backbone server URLs must be non-empty strings");
  }

  const candidate = normalizedValue.includes("://") ? normalizedValue : `nats://${normalizedValue}`;
  const parsed = new URL(candidate);

  if (parsed.protocol === "nats:") {
    parsed.protocol = "nats-leaf:";
    return parsed.toString();
  }

  if (
    parsed.protocol === "nats-leaf:" ||
    parsed.protocol === "tls:" ||
    parsed.protocol === "ws:" ||
    parsed.protocol === "wss:"
  ) {
    return parsed.toString();
  }

  throw new TypeError(
    `Unsupported backbone server URL protocol "${parsed.protocol}". ` +
    `Use nats:// or nats-leaf:// for native leafnode remotes, ` +
    `tls:// for TLS-first leafnode remotes, or ws:// / wss:// for WebSocket leaf remotes.`,
  );
}

async function runCommand(command, args, options = {}) {
  const {
    timeoutMs,
    ...spawnOptions
  } = options;

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOptions,
    });

    let stdout = "";
    let stderr = "";
    let finished = false;
    let timeoutId = null;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        if (finished) return;
        finished = true;
        child.kill("SIGKILL");
        const failure = new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`);
        failure.code = "ETIMEDOUT";
        failure.stdout = stdout;
        failure.stderr = stderr;
        reject(failure);
      }, timeoutMs);
      timeoutId.unref?.();
    }

    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      if (timeoutId) clearTimeout(timeoutId);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (finished) return;
      finished = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const failure = new Error(
        `${command} ${args.join(" ")} exited with code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}`,
      );
      failure.code = code;
      failure.signal = signal;
      failure.stdout = stdout;
      failure.stderr = stderr;
      reject(failure);
    });
  });
}

async function fetchWithChecks(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
    },
    redirect: "follow",
  });

  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return response;
}

async function downloadText(url) {
  const response = await fetchWithChecks(url);
  return await response.text();
}

async function downloadFile(url, filePath) {
  const response = await fetchWithChecks(url);
  const tempOutput = createWriteStream(filePath);
  await pipeline(Readable.fromWeb(response.body), tempOutput);
}

async function computeSha256(filePath) {
  const input = await readFile(filePath);
  return createHash("sha256").update(input).digest("hex");
}

function parseSha256SumsFile(text, assetName) {
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (!match) continue;
    if (match[2] === assetName) {
      return match[1].toLowerCase();
    }
  }

  return null;
}

async function extractArchive(archivePath, outputDir, archiveType) {
  await mkdir(outputDir, { recursive: true });

  if (archiveType === "tar.gz") {
    await runCommand("tar", ["-xzf", archivePath, "-C", outputDir]);
    return;
  }

  if (archiveType === "zip" && process.platform === "win32") {
    const escapedArchive = archivePath.replace(/'/g, "''");
    const escapedOutput = outputDir.replace(/'/g, "''");
    await runCommand("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedOutput}' -Force`,
    ]);
    return;
  }

  throw new Error(`Archive extraction for ${archiveType} is not implemented on ${process.platform}`);
}

async function findFileRecursive(rootDir, fileName) {
  const entries = await readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      return entryPath;
    }

    if (entry.isDirectory()) {
      const nested = await findFileRecursive(entryPath, fileName);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

export async function validateNatsServerBinary(binaryPath) {
  await access(binaryPath);
  if (process.platform !== "win32") {
    await chmod(binaryPath, 0o755);
  }

  const versionResult = await runCommand(binaryPath, ["-v"]);
  const combinedOutput = `${versionResult.stdout}\n${versionResult.stderr}`;
  const versionMatch = combinedOutput.match(/v(\d+\.\d+\.\d+)/);
  if (!versionMatch) {
    throw new Error(`Unable to determine nats-server version from "${binaryPath}"`);
  }

  if (versionMatch[1] !== NATS_SERVER_VERSION) {
    throw new Error(
      `Expected nats-server v${NATS_SERVER_VERSION}, but "${binaryPath}" reported v${versionMatch[1]}`,
    );
  }

  return {
    binaryPath,
    version: versionMatch[1],
  };
}

async function installBundledNatsServer({ cacheDir, logger }) {
  const assetSpec = getNatsServerAssetSpec();
  if (!assetSpec) {
    throw createUnsupportedPlatformError();
  }

  const installDir = resolveLeafBinaryInstallDir(cacheDir);
  const targetBinaryPath = path.join(installDir, assetSpec.binaryName);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "kinopio-nats-server-"));
  const archivePath = path.join(tempRoot, assetSpec.assetName);
  const extractDir = path.join(tempRoot, "extract");

  try {
    emit(logger, "info", `[kinopio-hub] downloading ${assetSpec.assetName}`);
    const [shaSumsFile] = await Promise.all([
      downloadText(SHA256SUMS_URL),
      downloadFile(assetSpec.downloadUrl, archivePath),
    ]);

    const expectedSha = parseSha256SumsFile(shaSumsFile, assetSpec.assetName);
    if (!expectedSha) {
      throw new Error(`Unable to locate SHA256 for ${assetSpec.assetName}`);
    }

    const actualSha = await computeSha256(archivePath);
    if (actualSha !== expectedSha) {
      throw new Error(
        `SHA256 mismatch for ${assetSpec.assetName}: expected ${expectedSha}, received ${actualSha}`,
      );
    }

    await extractArchive(archivePath, extractDir, assetSpec.archiveType);
    const extractedBinaryPath = await findFileRecursive(extractDir, assetSpec.binaryName);
    if (!extractedBinaryPath) {
      throw new Error(`Unable to locate ${assetSpec.binaryName} after extracting ${assetSpec.assetName}`);
    }

    await mkdir(installDir, { recursive: true });
    await copyFile(extractedBinaryPath, targetBinaryPath);
    if (process.platform !== "win32") {
      await chmod(targetBinaryPath, 0o755);
    }

    await writeFile(
      path.join(installDir, "install-metadata.json"),
      JSON.stringify(
        {
          version: NATS_SERVER_VERSION,
          assetName: assetSpec.assetName,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    emit(logger, "info", `[kinopio-hub] cached nats-server v${NATS_SERVER_VERSION} at ${targetBinaryPath}`);
    return await validateNatsServerBinary(targetBinaryPath);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function ensureNatsServerBinary({ cacheDir, binaryPath, logger = console } = {}) {
  if (binaryPath) {
    return await validateNatsServerBinary(path.resolve(binaryPath));
  }

  const assetSpec = getNatsServerAssetSpec();
  if (!assetSpec) {
    throw createUnsupportedPlatformError();
  }

  const installDir = resolveLeafBinaryInstallDir(cacheDir);
  const resolvedBinaryPath = path.join(installDir, assetSpec.binaryName);

  try {
    const fileStats = await stat(resolvedBinaryPath);
    if (fileStats.isFile()) {
      try {
        return await validateNatsServerBinary(resolvedBinaryPath);
      } catch (error) {
        emit(logger, "warn", `[kinopio-hub] reinstalling cached nats-server after validation failure: ${error.message}`);
      }
    }
  } catch {
    // Ignore and fall through to installation.
  }

  return await installBundledNatsServer({ cacheDir, logger });
}

export { createUnsupportedPlatformError, runCommand };
