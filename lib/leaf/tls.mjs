import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isIpv4Address, isWebSocketTlsEnabled } from "./config.mjs";
import { resolveLeafCacheRoot, runCommand } from "./runtime.mjs";

const GENERATED_CA_VALIDITY_DAYS = 3650;
const GENERATED_LEAF_CERT_VALIDITY_DAYS = 30;
const TRUST_INSTALL_COMMAND_TIMEOUT_MS = 8_000;

export function createLeafSecurityPaths(customCacheDir) {
  const securityDir = path.join(resolveLeafCacheRoot(customCacheDir), "kinopio-hub", "leaf-ca");
  return {
    securityDir,
    caCertFile: path.join(securityDir, "kinopio-leaf-root-ca.pem"),
    caKeyFile: path.join(securityDir, "kinopio-leaf-root-ca-key.pem"),
    caSerialFile: path.join(securityDir, "kinopio-leaf-root-ca.srl"),
    trustStateFile: path.join(securityDir, "kinopio-leaf-root-ca-trust.json"),
    linuxSystemCaFile: "/usr/local/share/ca-certificates/kinopio-hub-local-leaf-ca.crt",
  };
}

export async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function computeFileSha256(filePath) {
  const contents = await readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

export function buildLeafTlsAltNames(advertisedHostname, lanBindAddress) {
  const altNames = [
    `IP:${lanBindAddress}`,
    "IP:127.0.0.1",
    "DNS:localhost",
  ];

  if (!isIpv4Address(advertisedHostname)) {
    altNames.unshift(`DNS:${advertisedHostname}`);
  } else {
    altNames.unshift(`IP:${advertisedHostname}`);
  }

  const hostName = os.hostname();
  if (hostName && hostName !== advertisedHostname && !hostName.includes(" ")) {
    altNames.push(`DNS:${hostName}`);
  }

  return altNames;
}

export function buildLeafOpenSslConfig({ commonName, altNames }) {
  return [
    "[req]",
    "distinguished_name = req_distinguished_name",
    "req_extensions = v3_req",
    "prompt = no",
    "",
    "[req_distinguished_name]",
    `CN = ${commonName}`,
    "",
    "[v3_req]",
    "basicConstraints = CA:FALSE",
    "keyUsage = critical, digitalSignature, keyEncipherment",
    "extendedKeyUsage = serverAuth",
    `subjectAltName = ${altNames.join(",")}`,
    "",
  ].join("\n");
}

export async function readTrustState(trustStateFile) {
  try {
    return JSON.parse(await readFile(trustStateFile, "utf8"));
  } catch {
    return null;
  }
}

export async function writeTrustState(trustStateFile, trustState) {
  await writeFile(trustStateFile, `${JSON.stringify(trustState, null, 2)}\n`, "utf8");
}

export async function ensureGeneratedLeafCertificateAuthority(securityPaths) {
  await mkdir(securityPaths.securityDir, { recursive: true });

  const hasCaCert = await fileExists(securityPaths.caCertFile);
  const hasCaKey = await fileExists(securityPaths.caKeyFile);
  if (hasCaCert && hasCaKey) {
    return {
      caCertFile: securityPaths.caCertFile,
      caKeyFile: securityPaths.caKeyFile,
      generated: false,
    };
  }

  try {
    await runCommand("openssl", [
      "req",
      "-x509",
      "-nodes",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-days",
      String(GENERATED_CA_VALIDITY_DAYS),
      "-subj",
      "/CN=KinopioHub Local Leaf Root CA",
      "-keyout",
      securityPaths.caKeyFile,
      "-out",
      securityPaths.caCertFile,
    ]);
  } catch (error) {
    throw new Error(
      `Unable to auto-generate the local KinopioHub root CA. ` +
      `Ensure "openssl" is available in PATH or provide options.tls.certFile/keyFile manually. ` +
      `Original error: ${error.stderr || error.message}`,
    );
  }

  return {
    caCertFile: securityPaths.caCertFile,
    caKeyFile: securityPaths.caKeyFile,
    generated: true,
  };
}

export function buildTrustStatus({
  state,
  strategy = null,
  detail = null,
  attempted = false,
  requiresUserAction = false,
  platform = process.platform,
}) {
  return {
    state,
    platform,
    strategy,
    detail,
    attempted,
    requiresUserAction,
  };
}

export async function maybeInstallGeneratedCaTrust(securityPaths, caCertFile) {
  const certificateFingerprint = await computeFileSha256(caCertFile);
  const cachedTrustState = await readTrustState(securityPaths.trustStateFile);
  if (
    cachedTrustState?.state === "installed" &&
    cachedTrustState?.fingerprint === certificateFingerprint &&
    cachedTrustState?.platform === process.platform
  ) {
    return buildTrustStatus({
      state: "installed",
      strategy: cachedTrustState.strategy || null,
      detail: cachedTrustState.detail || null,
      attempted: false,
      requiresUserAction: false,
    });
  }

  if (process.env.KINOPIO_SKIP_CA_TRUST_INSTALL === "1") {
    return buildTrustStatus({
      state: "skipped",
      strategy: "env-skip",
      detail: "Skipped CA trust installation because KINOPIO_SKIP_CA_TRUST_INSTALL=1.",
      attempted: false,
      requiresUserAction: false,
    });
  }

  let trustStatus;

  if (process.platform === "darwin") {
    if (!process.stdin?.isTTY && !process.stdout?.isTTY) {
      trustStatus = buildTrustStatus({
        state: "skipped",
        strategy: "security add-trusted-cert",
        detail: "Skipped automatic CA trust installation in a non-interactive macOS session.",
        attempted: false,
        requiresUserAction: true,
      });
    } else {
      try {
        await runCommand(
          "security",
          [
            "add-trusted-cert",
            "-r",
            "trustRoot",
            "-p",
            "ssl",
            "-k",
            path.join(os.homedir(), "Library", "Keychains", "login.keychain-db"),
            caCertFile,
          ],
          { timeoutMs: TRUST_INSTALL_COMMAND_TIMEOUT_MS },
        );
        trustStatus = buildTrustStatus({
          state: "installed",
          strategy: "security add-trusted-cert",
          detail: "Added the generated CA to the current user's login keychain trust settings for SSL.",
          attempted: true,
          requiresUserAction: false,
        });
      } catch (error) {
        const detail = error.stderr || error.message;
        const requiresUserAction =
          error.code === "ETIMEDOUT" ||
          /interaction|denied|authorization|user interaction/i.test(detail);
        trustStatus = buildTrustStatus({
          state: requiresUserAction ? "skipped" : "failed",
          strategy: "security add-trusted-cert",
          detail,
          attempted: true,
          requiresUserAction,
        });
      }
    }
  } else if (process.platform === "win32") {
    try {
      await runCommand(
        "certutil",
        ["-user", "-addstore", "Root", caCertFile],
        { timeoutMs: TRUST_INSTALL_COMMAND_TIMEOUT_MS },
      );
      trustStatus = buildTrustStatus({
        state: "installed",
        strategy: "certutil -user -addstore Root",
        detail: "Added the generated CA to the current user's trusted root store.",
        attempted: true,
        requiresUserAction: false,
      });
    } catch (error) {
      trustStatus = buildTrustStatus({
        state: "failed",
        strategy: "certutil -user -addstore Root",
        detail: error.stderr || error.message,
        attempted: true,
        requiresUserAction: false,
      });
    }
  } else if (process.platform === "linux") {
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      trustStatus = buildTrustStatus({
        state: "skipped",
        strategy: "update-ca-certificates",
        detail: "Skipped automatic CA trust installation because Linux system trust updates typically require root privileges.",
        attempted: false,
        requiresUserAction: true,
      });
    } else {
      try {
        await copyFile(caCertFile, securityPaths.linuxSystemCaFile);
        await runCommand(
          "update-ca-certificates",
          [],
          { timeoutMs: TRUST_INSTALL_COMMAND_TIMEOUT_MS },
        );
        trustStatus = buildTrustStatus({
          state: "installed",
          strategy: "update-ca-certificates",
          detail: `Installed the generated CA into ${securityPaths.linuxSystemCaFile} and refreshed the system CA bundle.`,
          attempted: true,
          requiresUserAction: false,
        });
      } catch (error) {
        const detail = error.stderr || error.message;
        const skipped = /not found|ENOENT|No such file/i.test(detail);
        trustStatus = buildTrustStatus({
          state: skipped ? "skipped" : "failed",
          strategy: "update-ca-certificates",
          detail,
          attempted: true,
          requiresUserAction: skipped,
        });
      }
    }
  } else {
    trustStatus = buildTrustStatus({
      state: "skipped",
      strategy: null,
      detail: `Automatic CA trust installation is not implemented for ${process.platform}.`,
      attempted: false,
      requiresUserAction: true,
    });
  }

  if (trustStatus.state === "installed") {
    await writeTrustState(securityPaths.trustStateFile, {
      ...trustStatus,
      fingerprint: certificateFingerprint,
      installedAt: new Date().toISOString(),
    });
  }

  return trustStatus;
}

export async function ensureTlsFiles(options, runtimePaths, advertisedHostname, lanBindAddress) {
  if (!isWebSocketTlsEnabled(options)) {
    if (options.tls?.certFile || options.tls?.keyFile) {
      throw new Error("options.tls.certFile/keyFile cannot be used when options.webSocketTls is false");
    }

    return {
      certFile: null,
      keyFile: null,
      generated: false,
      caCertFile: null,
      trustStatus: buildTrustStatus({
        state: "skipped",
        strategy: "no-tls",
        detail: "Local WebSocket TLS is disabled via options.webSocketTls=false.",
        attempted: false,
        requiresUserAction: false,
      }),
      mode: "disabled",
    };
  }

  if (options.tls?.certFile || options.tls?.keyFile) {
    if (!options.tls?.certFile || !options.tls?.keyFile) {
      throw new Error("options.tls.certFile and options.tls.keyFile must be provided together");
    }

    await access(options.tls.certFile);
    await access(options.tls.keyFile);
    return {
      certFile: path.resolve(options.tls.certFile),
      keyFile: path.resolve(options.tls.keyFile),
      generated: false,
      caCertFile: null,
      trustStatus: buildTrustStatus({
        state: "external",
        strategy: null,
        detail: "Using caller-provided TLS certificate and key files.",
        attempted: false,
        requiresUserAction: false,
      }),
      mode: "external",
    };
  }

  const securityPaths = createLeafSecurityPaths(options.cacheDir);
  const generatedCa = await ensureGeneratedLeafCertificateAuthority(securityPaths);
  const openSslConfig = path.join(runtimePaths.certsDir, "openssl.cnf");
  const csrFile = path.join(runtimePaths.certsDir, "leaf.csr");
  const altNames = buildLeafTlsAltNames(advertisedHostname, lanBindAddress);
  const configContents = buildLeafOpenSslConfig({
    commonName: advertisedHostname,
    altNames,
  });
  await writeFile(openSslConfig, configContents, "utf8");

  try {
    await runCommand("openssl", [
      "req",
      "-nodes",
      "-newkey",
      "rsa:2048",
      "-keyout",
      runtimePaths.keyFile,
      "-out",
      csrFile,
      "-config",
      openSslConfig,
      "-reqexts",
      "v3_req",
    ]);
    await runCommand("openssl", [
      "x509",
      "-req",
      "-in",
      csrFile,
      "-CA",
      generatedCa.caCertFile,
      "-CAkey",
      generatedCa.caKeyFile,
      "-CAcreateserial",
      "-out",
      runtimePaths.certFile,
      "-days",
      String(GENERATED_LEAF_CERT_VALIDITY_DAYS),
      "-sha256",
      "-extfile",
      openSslConfig,
      "-extensions",
      "v3_req",
    ]);
  } catch (error) {
    throw new Error(
      `Unable to auto-generate TLS files for the local leaf runtime. ` +
      `Provide options.tls.certFile/keyFile or ensure "openssl" is available in PATH. ` +
      `Original error: ${error.stderr || error.message}`,
    );
  }

  const trustStatus = await maybeInstallGeneratedCaTrust(securityPaths, generatedCa.caCertFile);

  return {
    certFile: runtimePaths.certFile,
    keyFile: runtimePaths.keyFile,
    generated: true,
    caCertFile: generatedCa.caCertFile,
    trustStatus,
    mode: "generated-ca",
  };
}
