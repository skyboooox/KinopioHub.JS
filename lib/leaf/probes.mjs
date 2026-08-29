import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const MAX_NATS_PROBE_BYTES = 64 * 1024;

function isIpv4Address(value) {
  return typeof value === "string" && /^(\d{1,3}\.){3}\d{1,3}$/u.test(value);
}

function resolveBackboneProbeTarget(url) {
  const parsed = new URL(url);
  let port = parsed.port ? Number(parsed.port) : 4_222;
  if (!parsed.port && parsed.protocol === "ws:") {
    port = 80;
  } else if (!parsed.port && parsed.protocol === "wss:") {
    port = 443;
  } else if (!parsed.port && (parsed.protocol === "nats-leaf:" || parsed.protocol === "tls:")) {
    port = 7_422;
  }

  return {
    host: parsed.hostname,
    port,
  };
}

function destroySocket(socket, listeners) {
  for (const [event, listener] of listeners) {
    socket.off(event, listener);
  }
  socket.on("error", () => {});
  socket.destroy();
}

export async function measureTcpConnectRtt({ host, port }, timeoutMs = 1_500) {
  const startedAt = performance.now();

  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      destroySocket(socket, [["connect", handleConnect], ["error", handleError]]);
      if (error) {
        reject(error);
      } else {
        resolve(Math.max(0, Math.round(performance.now() - startedAt)));
      }
    };
    const handleConnect = () => finish();
    const handleError = error => finish(error);
    const timeout = setTimeout(
      () => finish(new Error(`Timed out connecting to ${host}:${port}`)),
      timeoutMs,
    );

    socket.once("connect", handleConnect);
    socket.once("error", handleError);
  });
}

export async function measureBackboneRtt(backboneServers) {
  if (!Array.isArray(backboneServers) || backboneServers.length === 0) {
    return null;
  }

  const samples = await Promise.allSettled(
    backboneServers.map(async (url) => {
      const target = resolveBackboneProbeTarget(url);
      return await measureTcpConnectRtt(target);
    }),
  );

  const successfulSamples = samples
    .filter(result => result.status === "fulfilled" && Number.isFinite(result.value))
    .map(result => result.value);

  if (successfulSamples.length === 0) {
    return null;
  }

  return Math.min(...successfulSamples);
}

export async function probeMonitorHealth(monitorUrl, timeoutMs = 2_000) {
  const healthUrl = new URL("/healthz", monitorUrl);
  await new Promise((resolve, reject) => {
    const request = http.get(healthUrl, (response) => {
      const chunks = [];
      response.setEncoding("utf8");
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode === 200) {
          resolve();
          return;
        }
        reject(new Error(`Monitoring health probe returned ${response.statusCode}: ${chunks.join("")}`));
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Timed out waiting for the monitoring health endpoint"));
    });
    request.on("error", reject);
  });
}

export async function probeNatsClient(clientPort) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: "127.0.0.1",
      port: clientPort,
    });
    let buffer = "";
    let bytesRead = 0;
    let pingSent = false;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      destroySocket(socket, [["error", handleError], ["data", handleData]]);
      if (error) reject(error);
      else resolve();
    };
    const handleError = error => finish(error);
    const handleData = (chunk) => {
      bytesRead += Buffer.byteLength(chunk);
      if (bytesRead > MAX_NATS_PROBE_BYTES) {
        finish(new Error("Local NATS client probe exceeded the response limit"));
        return;
      }

      buffer += chunk;
      if (!pingSent && buffer.includes("INFO")) {
        socket.write('CONNECT {"verbose":false,"pedantic":false}\r\nPING\r\n');
        pingSent = true;
      }
      if (pingSent && buffer.includes("PONG")) {
        finish();
      }
    };
    const timeout = setTimeout(
      () => finish(new Error("Timed out waiting for the local NATS client listener")),
      2_000,
    );

    socket.setEncoding("utf8");
    socket.on("error", handleError);
    socket.on("data", handleData);
  });
}

export async function probeTlsListener(host, port) {
  await new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      rejectUnauthorized: false,
      servername: isIpv4Address(host) ? undefined : host,
    });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      destroySocket(socket, [["secureConnect", handleConnect], ["error", handleError]]);
      if (error) reject(error);
      else resolve();
    };
    const handleConnect = () => finish();
    const handleError = error => finish(error);
    const timeout = setTimeout(
      () => finish(new Error("Timed out waiting for the local WSS listener")),
      2_000,
    );

    socket.once("secureConnect", handleConnect);
    socket.once("error", handleError);
  });
}

export async function probeTcpListener(host, port) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      destroySocket(socket, [["connect", handleConnect], ["error", handleError]]);
      if (error) reject(error);
      else resolve();
    };
    const handleConnect = () => finish();
    const handleError = error => finish(error);
    const timeout = setTimeout(
      () => finish(new Error("Timed out waiting for the local WS listener")),
      2_000,
    );

    socket.once("connect", handleConnect);
    socket.once("error", handleError);
  });
}

export async function probeDiscoveryEndpoint(discoveryUrl, timeoutMs = 2_000) {
  await new Promise((resolve, reject) => {
    const url = new URL(discoveryUrl);
    const requestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
    };
    const client = url.protocol === "https:" ? https : http;
    if (url.protocol === "https:") {
      requestOptions.rejectUnauthorized = false;
      requestOptions.servername = isIpv4Address(url.hostname) ? undefined : url.hostname;
    }

    const request = client.get(requestOptions, (response) => {
      const chunks = [];
      response.setEncoding("utf8");
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Discovery probe returned ${response.statusCode}: ${chunks.join("")}`));
          return;
        }

        try {
          JSON.parse(chunks.join(""));
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Timed out waiting for the discovery endpoint"));
    });
    request.on("error", reject);
  });
}

export async function fetchJson(url, timeoutMs = 3_000) {
  return await new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const request = http.get(parsedUrl, (response) => {
      const chunks = [];
      response.setEncoding("utf8");
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} from ${url}`));
          return;
        }

        try {
          resolve(JSON.parse(chunks.join("")));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Timed out fetching ${url}`));
    });
    request.on("error", reject);
  });
}
