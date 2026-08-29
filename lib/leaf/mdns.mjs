export const KINOPIO_MDNS_SERVICE_TYPE = "_kinopio-leaf._tcp.local.";

const DNS_CLASS_IN = 0x0001;
const DNS_RECORD_A = 0x0001;
const DNS_RECORD_PTR = 0x000c;
const DNS_RECORD_TXT = 0x0010;
const DNS_RECORD_SRV = 0x0021;

class MdnsParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "MdnsParseError";
  }
}

function ensureTrailingDot(name) {
  return name.endsWith(".") ? name : `${name}.`;
}

function trimTrailingDot(name) {
  return name.endsWith(".") ? name.slice(0, -1) : name;
}

function sanitizeLabelPart(value, fallback = "kinopio") {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");

  return (normalized || fallback).slice(0, 48);
}

function encodeName(name) {
  const fqdn = ensureTrailingDot(name);
  const labels = trimTrailingDot(fqdn).split(".").filter(Boolean);
  const parts = [];

  for (const label of labels) {
    const bytes = Buffer.from(label, "utf8");
    parts.push(Buffer.from([bytes.length]));
    parts.push(bytes);
  }

  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function decodeName(buffer, offset, visited = new Set(), state = { labels: 0 }) {
  if (!Number.isInteger(offset) || offset < 0 || offset >= buffer.length) {
    throw new MdnsParseError("mDNS name offset is outside the packet");
  }

  if (visited.has(offset)) {
    throw new MdnsParseError("mDNS name compression loop detected");
  }

  visited.add(offset);

  const labels = [];
  let cursor = offset;
  let consumed = 0;
  let jumped = false;

  while (true) {
    if (cursor >= buffer.length) {
      throw new MdnsParseError("Truncated mDNS name");
    }

    const length = buffer[cursor];

    if (length === 0) {
      if (!jumped) consumed += 1;
      cursor += 1;
      break;
    }

    if ((length & 0xc0) === 0xc0) {
      if (cursor + 1 >= buffer.length) {
        throw new MdnsParseError("Truncated mDNS compression pointer");
      }
      const pointer = ((length & 0x3f) << 8) | buffer[cursor + 1];
      const decoded = decodeName(buffer, pointer, visited, state);
      labels.push(trimTrailingDot(decoded.name));
      if (!jumped) consumed += 2;
      cursor += 2;
      jumped = true;
      break;
    }

    const start = cursor + 1;
    const end = start + length;
    if (end > buffer.length) {
      throw new MdnsParseError("Truncated mDNS label");
    }
    state.labels += 1;
    if (state.labels > 128) {
      throw new MdnsParseError("mDNS name contains too many labels");
    }
    labels.push(buffer.slice(start, end).toString("utf8"));
    if (!jumped) consumed += length + 1;
    cursor = end;
  }

  return {
    name: `${labels.filter(Boolean).join(".")}.`,
    nextOffset: offset + consumed,
  };
}

function encodeTxtData(strings) {
  const parts = [];

  for (const entry of strings) {
    const bytes = Buffer.from(entry, "utf8");
    parts.push(Buffer.from([bytes.length]));
    parts.push(bytes);
  }

  if (parts.length === 0) {
    return Buffer.from([0]);
  }

  return Buffer.concat(parts);
}

function decodeTxtData(buffer) {
  const values = {};
  let cursor = 0;

  while (cursor < buffer.length) {
    const length = buffer[cursor];
    cursor += 1;
    if (cursor + length > buffer.length) {
      throw new MdnsParseError("Truncated mDNS TXT value");
    }
    const value = buffer.slice(cursor, cursor + length).toString("utf8");
    cursor += length;

    if (!value) continue;
    const separatorIndex = value.indexOf("=");
    if (separatorIndex === -1) {
      values[value.toLowerCase()] = "";
      continue;
    }

    const key = value.slice(0, separatorIndex).toLowerCase();
    if (!(key in values)) {
      values[key] = value.slice(separatorIndex + 1);
    }
  }

  return values;
}

function encodeRecord(record) {
  const nameBuffer = encodeName(record.name);
  let rdata = Buffer.alloc(0);

  switch (record.type) {
    case DNS_RECORD_PTR:
      rdata = encodeName(record.data.target);
      break;
    case DNS_RECORD_SRV:
      rdata = Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x00]),
        Buffer.from([(record.data.port >> 8) & 0xff, record.data.port & 0xff]),
        encodeName(record.data.target),
      ]);
      break;
    case DNS_RECORD_TXT:
      rdata = encodeTxtData(record.data.strings);
      break;
    case DNS_RECORD_A:
      rdata = Buffer.from(record.data.address.split(".").map(Number));
      break;
    default:
      throw new Error(`Unsupported mDNS record type: ${record.type}`);
  }

  const header = Buffer.alloc(10);
  header.writeUInt16BE(record.type, 0);
  header.writeUInt16BE(DNS_CLASS_IN, 2);
  header.writeUInt32BE(record.ttlSeconds, 4);
  header.writeUInt16BE(rdata.length, 8);

  return Buffer.concat([nameBuffer, header, rdata]);
}

function parseRecordData(type, buffer, offset, length) {
  if (offset + length > buffer.length) {
    throw new MdnsParseError("Truncated mDNS record data");
  }

  switch (type) {
    case DNS_RECORD_PTR: {
      const target = decodeName(buffer, offset);
      return {
        value: {
          target: target.name,
        },
        nextOffset: offset + length,
      };
    }
    case DNS_RECORD_SRV: {
      if (offset + 6 > buffer.length || length < 6) {
        throw new MdnsParseError("Truncated mDNS SRV record");
      }
      const port = buffer.readUInt16BE(offset + 4);
      const target = decodeName(buffer, offset + 6);
      return {
        value: {
          port,
          target: target.name,
        },
        nextOffset: offset + length,
      };
    }
    case DNS_RECORD_TXT: {
      return {
        value: decodeTxtData(buffer.slice(offset, offset + length)),
        nextOffset: offset + length,
      };
    }
    case DNS_RECORD_A: {
      const octets = [...buffer.slice(offset, offset + length)];
      return {
        value: {
          address: octets.join("."),
        },
        nextOffset: offset + length,
      };
    }
    default:
      return {
        value: buffer.slice(offset, offset + length),
        nextOffset: offset + length,
      };
  }
}

function parseRecords(buffer, count, offset) {
  const records = [];
  let cursor = offset;

  for (let index = 0; index < count; index += 1) {
    const decodedName = decodeName(buffer, cursor);
    cursor = decodedName.nextOffset;
    if (cursor + 10 > buffer.length) {
      throw new MdnsParseError("Truncated mDNS record header");
    }
    const type = buffer.readUInt16BE(cursor);
    const recordClass = buffer.readUInt16BE(cursor + 2);
    const ttl = buffer.readUInt32BE(cursor + 4);
    const dataLength = buffer.readUInt16BE(cursor + 8);
    const dataOffset = cursor + 10;
    const parsed = parseRecordData(type, buffer, dataOffset, dataLength);

    records.push({
      name: decodedName.name,
      type,
      class: recordClass,
      ttl,
      data: parsed.value,
    });

    cursor = parsed.nextOffset;
  }

  return {
    records,
    nextOffset: cursor,
  };
}

export function buildMdnsQueryPacket(serviceTypeName = KINOPIO_MDNS_SERVICE_TYPE) {
  const questionName = ensureTrailingDot(serviceTypeName);
  const question = Buffer.concat([
    encodeName(questionName),
    Buffer.from([0x00, DNS_RECORD_PTR, 0x00, DNS_CLASS_IN]),
  ]);

  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x0000, 0);
  header.writeUInt16BE(0x0000, 2);
  header.writeUInt16BE(0x0001, 4);

  return Buffer.concat([header, question]);
}

export function buildServiceInstanceName(discoveryNamespace, nodeId) {
  const namespaceLabel = sanitizeLabelPart(discoveryNamespace, "ns");
  const nodeLabel = sanitizeLabelPart(nodeId, "node").slice(0, 12);
  return `${namespaceLabel}-${nodeLabel}.${KINOPIO_MDNS_SERVICE_TYPE}`;
}

export function buildHostRecordName(nodeId) {
  const nodeLabel = sanitizeLabelPart(nodeId, "node").slice(0, 16);
  return `kinopio-${nodeLabel}.local.`;
}

export function buildMdnsAnnouncementPacket({
  discoveryNamespace,
  nodeId,
  advertisedHostname,
  advertisedAddress,
  discoveryPort,
  websocketPort,
  websocketProtocol = "wss",
  discoveryProtocol = "https",
  leaderEpoch,
  leaseExpiresAt,
  backboneRttMs,
  ttlSeconds = 5,
  serviceTypeName = KINOPIO_MDNS_SERVICE_TYPE,
}) {
  const normalizedServiceType = ensureTrailingDot(serviceTypeName);
  const instanceName = buildServiceInstanceName(discoveryNamespace, nodeId);
  const hostName = buildHostRecordName(nodeId);
  const normalizedWebsocketProtocol = websocketProtocol === "ws" ? "ws" : "wss";
  const normalizedDiscoveryProtocol = discoveryProtocol === "http" ? "http" : "https";
  const txtStrings = [
    "txtvers=1",
    `ns=${discoveryNamespace}`,
    `node=${nodeId}`,
    `host=${advertisedHostname || advertisedAddress}`,
    `epoch=${leaderEpoch}`,
    `lease=${leaseExpiresAt}`,
    `wssp=${websocketPort}`,
    `wsproto=${normalizedWebsocketProtocol}`,
    `discproto=${normalizedDiscoveryProtocol}`,
    `rtt=${backboneRttMs ?? ""}`,
  ];

  const records = [
    {
      name: normalizedServiceType,
      type: DNS_RECORD_PTR,
      ttlSeconds,
      data: {
        target: instanceName,
      },
    },
    {
      name: instanceName,
      type: DNS_RECORD_SRV,
      ttlSeconds,
      data: {
        port: discoveryPort,
        target: hostName,
      },
    },
    {
      name: instanceName,
      type: DNS_RECORD_TXT,
      ttlSeconds,
      data: {
        strings: txtStrings,
      },
    },
    {
      name: hostName,
      type: DNS_RECORD_A,
      ttlSeconds,
      data: {
        address: advertisedAddress,
      },
    },
  ];

  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x0000, 0);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(0x0000, 4);
  header.writeUInt16BE(records.length, 6);

  return Buffer.concat([header, ...records.map(encodeRecord)]);
}

export function parseMdnsPacket(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return {
      questions: [],
      answers: [],
      additionals: [],
    };
  }

  try {
    const questionCount = buffer.readUInt16BE(4);
    const answerCount = buffer.readUInt16BE(6);
    const authorityCount = buffer.readUInt16BE(8);
    const additionalCount = buffer.readUInt16BE(10);

    const questions = [];
    let cursor = 12;

    for (let index = 0; index < questionCount; index += 1) {
      const decodedName = decodeName(buffer, cursor);
      cursor = decodedName.nextOffset;
      if (cursor + 4 > buffer.length) {
        throw new MdnsParseError("Truncated mDNS question");
      }
      const type = buffer.readUInt16BE(cursor);
      const recordClass = buffer.readUInt16BE(cursor + 2);
      cursor += 4;
      questions.push({
        name: decodedName.name,
        type,
        class: recordClass,
      });
    }

    const answers = parseRecords(buffer, answerCount, cursor);
    const authorities = parseRecords(buffer, authorityCount, answers.nextOffset);
    const additionals = parseRecords(buffer, additionalCount, authorities.nextOffset);

    return {
      questions,
      answers: answers.records,
      additionals: [...authorities.records, ...additionals.records],
    };
  } catch {
    return {
      questions: [],
      answers: [],
      additionals: [],
    };
  }
}

export function extractKinopioLeafManifests(packet, {
  serviceTypeName = KINOPIO_MDNS_SERVICE_TYPE,
  manifestPath = "/.well-known/kinopio-leader.json",
} = {}) {
  const normalizedServiceType = ensureTrailingDot(serviceTypeName);
  const records = [...(packet.answers || []), ...(packet.additionals || [])];
  const serviceInstances = new Map();

  for (const record of records) {
    if (record.type === DNS_RECORD_PTR && record.name === normalizedServiceType) {
      const entry = serviceInstances.get(record.data.target) || {};
      entry.ptr = record;
      serviceInstances.set(record.data.target, entry);
      continue;
    }

    const entry = serviceInstances.get(record.name) || {};
    if (record.type === DNS_RECORD_SRV) {
      entry.srv = record;
      serviceInstances.set(record.name, entry);
      continue;
    }

    if (record.type === DNS_RECORD_TXT) {
      entry.txt = record;
      serviceInstances.set(record.name, entry);
      continue;
    }
  }

  const hostRecords = new Map(
    records
      .filter(record => record.type === DNS_RECORD_A)
      .map(record => [record.name, record.data.address]),
  );

  const manifests = [];

  for (const entry of serviceInstances.values()) {
    if (!entry.ptr || !entry.srv || !entry.txt) continue;

    const txt = entry.txt.data || {};
    const namespace = txt.ns;
    const nodeId = txt.node;
    const websocketPort = Number(txt.wssp);
    const websocketProtocol = txt.wsproto === "ws" ? "ws" : "wss";
    const discoveryProtocol = txt.discproto === "http" ? "http" : "https";
    const leaderEpoch = Number(txt.epoch || 0);
    const leaseExpiresAt = txt.lease;
    const backboneRttMs = txt.rtt === "" ? null : Number(txt.rtt);
    const hostName = entry.srv.data.target;
    const advertisedHostname = txt.host || hostRecords.get(hostName) || trimTrailingDot(hostName);

    if (!namespace || !nodeId || !Number.isInteger(websocketPort) || websocketPort <= 0) {
      continue;
    }

    manifests.push({
      version: "1",
      expiresAt: leaseExpiresAt || "",
      leaderEpoch,
      leaseExpiresAt,
      backboneRttMs: Number.isFinite(backboneRttMs) ? backboneRttMs : null,
      advertisedHostname,
      websocketUrl: `${websocketProtocol}://${advertisedHostname}:${websocketPort}`,
      wssUrl: `${websocketProtocol}://${advertisedHostname}:${websocketPort}`,
      discoveryUrl: `${discoveryProtocol}://${advertisedHostname}:${entry.srv.data.port}${manifestPath}`,
      fallbackServers: [],
      nodeId,
      discoveryNamespace: namespace,
      isLeader: true,
      candidateRole: "leader",
    });
  }

  return manifests;
}
