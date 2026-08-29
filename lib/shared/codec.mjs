// Data (de)serialization engine. Contract (unchanged since 2.x):
//   serialize:   null/undefined -> empty bytes; Uint8Array passthrough;
//                string -> utf8; custom codec.encode -> JSON(replacer) -> String fallbacks
//   deserialize: empty -> null; custom codec.decode -> JSON(reviver) -> text -> raw bytes fallbacks
// Pure — safe for browser bundles.

function createTextDecoder() {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8");
  }

  return {
    decode: (uint8Array) => {
      try {
        return String.fromCharCode(...uint8Array);
      } catch {
        return Array.from(uint8Array, (byte) => String.fromCharCode(byte)).join("");
      }
    },
  };
}

function createTextEncoder() {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder();
  }

  return {
    encode: (text) => {
      const result = new Uint8Array(text.length);
      for (let index = 0; index < text.length; index++) {
        result[index] = text.charCodeAt(index);
      }
      return result;
    },
  };
}

export function bytesEqual(left, right) {
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export class DataCodec {
  #codec;
  #jsonReplacer;
  #jsonReviver;
  #log;
  textEncoder = createTextEncoder();
  textDecoder = createTextDecoder();

  constructor({ codec, jsonReplacer, jsonReviver, log } = {}) {
    this.#codec = codec ?? null;
    this.#jsonReplacer = jsonReplacer ?? undefined;
    this.#jsonReviver = jsonReviver ?? undefined;
    this.#log = log ?? (() => {});
  }

  serialize(data) {
    if (data === null || data === undefined) {
      return new Uint8Array(0);
    }

    if (data instanceof Uint8Array) {
      return data;
    }

    if (typeof data === "string") {
      return this.textEncoder.encode(data);
    }

    if (this.#codec?.encode) {
      try {
        return this.#codec.encode(data);
      } catch (error) {
        this.#log("warn", "Custom codec.encode failed, fallback to JSON:", error);
      }
    }

    try {
      const jsonString = JSON.stringify(data, this.#jsonReplacer);
      return this.textEncoder.encode(jsonString);
    } catch (error) {
      this.#log("warn", "Serialization failed, using string conversion:", error);
      return this.textEncoder.encode(String(data));
    }
  }

  deserialize(uint8Array) {
    if (!uint8Array || uint8Array.length === 0) {
      return null;
    }

    if (this.#codec?.decode) {
      try {
        return this.#codec.decode(uint8Array);
      } catch (error) {
        this.#log("warn", "Custom codec.decode failed, fallback to text/JSON:", error);
      }
    }

    try {
      const text = this.textDecoder.decode(uint8Array);

      try {
        return JSON.parse(text, this.#jsonReviver);
      } catch {
        return text;
      }
    } catch (error) {
      this.#log("warn", "Deserialization failed:", error);
      return uint8Array;
    }
  }
}
