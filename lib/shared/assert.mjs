// Shared validation and small utility helpers. Pure — safe for browser bundles.

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isPositiveFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function isNodeRuntime() {
  return (
    typeof process !== "undefined" &&
    process?.versions !== undefined &&
    typeof process.versions.node === "string"
  );
}

export function assertNodeRuntime(apiName) {
  if (!isNodeRuntime()) {
    throw new Error(`${apiName} requires a Node.js runtime`);
  }
}

export function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

export function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

export function assertOptionalString(value, label) {
  if (value !== undefined && typeof value !== "string") {
    throw new TypeError(`${label} must be a string when provided`);
  }
}

export function assertOptionalPositiveNumber(value, label) {
  if (value === undefined) return;
  if (!isPositiveFiniteNumber(value)) {
    throw new TypeError(`${label} must be a positive finite number when provided`);
  }
}

export function assertOptionalBoolean(value, label) {
  if (value !== undefined && typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean when provided`);
  }
}

export function assertOptionalPort(value, label) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new TypeError(`${label} must be an integer between 1 and 65535 when provided`);
  }
}

export function assertOptionalStringArray(value, label) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`${label} must be an array of strings when provided`);
  }
}

export function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Abortable sleep. Resolves after `milliseconds`, or immediately when the
 * signal aborts (never rejects — callers check the signal themselves).
 */
export function sleep(milliseconds, { signal } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    let onAbort = null;
    const timer = setTimeout(() => {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    timer.unref?.();

    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
