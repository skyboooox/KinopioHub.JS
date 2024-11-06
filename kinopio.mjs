import { connect, StringCodec } from "nats.ws";
import { event, nanoid } from "skyboxtool"

let nats = null;
const codec = StringCodec();
let status = 0;

/**
 * 
 * @param {Object} opt all options
 * @returns {object} handler
 */
export async function client(opt) {
    let handler = {}
    const options = {
        debug: false,
        servers: ["wss://demo.nats.io:8443","wss://demo.nats.io:4443"],
        noEcho: true,
        noRandomize: true,
        maxReconnectAttempts: -1,
        waitOnFirstConnect: true,
        reconnectTimeout: 5000,
        reconnectTimeWait: 500,
        pingInterval: 3000,
        maxPingOut: 3,
        timeout: 3000,
        healthReport: 5000,
        fetchRemoteVar: false,
        ...opt
    }
    let { debug, reconnectTimeout } = options;

    if (typeof process !== 'undefined' && process?.versions?.node) {
        const ws = await import("websocket")
        globalThis.WebSocket = ws.default.w3cwebsocket;
        options.node = true;
    }

    const reset = async () => {
        status = 0;
        clearTimeout(_connect.daemon);
        try {
            if (nats) await nats.close();
            nats = null;
        } catch (error) {
            console.log(error)
        }
    }

    const failed = async (error) => {
        event.emit("kinopio.disconnected", nats);
        if (debug) console.warn(`[Kinopio] Connection Failed`, error);
        reconnect();
    }

    const reconnect = async () => {
        await reset();
        clearTimeout(reconnect.timeout);
        reconnect.timeout = setTimeout(_connect, reconnectTimeout);
    }
    const daemon = async () => {
        if (nats && (nats.isClosed() || nats.protocol.transport.isClosed)) {
            failed(new Error('Connection closed'));
        }
    }

    const _connect = async () => {

        const nowTime = Date.now();
        await reset();
        console.log("[Kinopio] Attempting to connect to 🍄Kinoko🍄");
        try {
            nats = await connect({
                servers: options.servers,
                noEcho: options.noEcho,
                noRandomize: options.noRandomize,
                maxReconnectAttempts: options.maxReconnectAttempts,
                waitOnFirstConnect: options.waitOnFirstConnect,
                reconnectTimeWait: options.reconnectTimeWait,
                pingInterval: options.pingInterval,
                maxPingOut: options.maxPingOut,
                timeout: options.timeout,
            });

            const useTime = (Date.now() - nowTime) / 1000;
            if (debug) {
                if (typeof process !== 'undefined' && process?.versions?.node) {
                    globalThis.nats = nats;
                } else {
                    window.nats = nats;
                }
                console.info(`[Kinopio] Connected to ${nats.getServer ? nats.getServer() : 'server'}, Use ${useTime}s`);
            } else {
                console.log(`[Kinopio] Connected to 🍄Kinoko🍄, Use ${useTime}s`);
            }
            status = 1;
            event.emit("kinopio.connected", nats);

            for await (const s of nats.status()) {
                if (debug) console.log("nats.status", s.type, s.data);
                if (["staleConnection", "disconnect", "error"].includes(s.type)) {
                    throw new Error(s.type);
                }
            }
        } catch (error) {
            failed(error);
        }
    }

    const connected = async () => {
        return new Promise((resolve, reject) => {
            event.on("kinopio.connected", () => {
                resolve(true)
            })
        })
    }

    /**
     * No return, use .on to listen
     * @param {String} name var name
     * @param {Boolean} readonly readonly hasn't set method
     *
     * 
     */
    const _var = async (name, readonly = true) => {
        if (!handler[name]) {
            handler[name] = {};
        }
        if (handler[name].on) {
            console.warn("[Kinopio] Var already exists:", name);
        }
        handler[name].on = async (cb) => {
            nats.subscribe(`${options.zoneID}.${name}`, {
                callback: async (err, msg) => {
                    if (err) {
                        console.warn("[Kinopio] Subscribe Error:", err);
                        return;
                    }
                    const data = codec.decode(msg.data);
                    if (debug) console.log("[Kinopio] Received:", data);
                    handler[name].value = data.value;
                    handler[name].timestamp = data.timestamp;
                    cb(data);
                }
            });
        };

        if (readonly) return;
        handler[name].set = async (value) => {
            nats.publish(`${options.zoneID}.${name}`, JSON.stringify({
                timestamp: Date.now(),
                value: value,
            }));
        }
    }

    /**
     * Serve a edpoint,like a http server
     * @param {Array} endpoint deault: [zoneID, nanoid()]
     * @param {callback} cb 
     */
    const serve_raw = async (endpoint = [options.zoneID, nanoid()], cb) => {
        console.log("serve_raw", endpoint.join("."))
        nats.subscribe(endpoint.join("."), { callback: cb });
    }
    /**
     * Serve a edpoint,like a http server
     * @param {Array} endpoint deault: [nanoid()]
     * @param {callback} cb 
     */
    const serve = async (endpoint = [nanoid()], cb) => {
        nats.subscribe(`${options.zoneID}.${endpoint.join(".")}`, {
            callback: async (err, msg) => {
                if (err) {
                    console.warn("[Serve] Subscribe Error:", err)
                    return
                }
                const data = JSON.parse(codec.decode(msg.data));
                if (debug) console.log("[Serve] Received data:", msg.subject, data);
                msg.respond(
                    JSON.stringify(
                        await cb(data)
                    )
                );
            }
        }
        );
    }

    /**
     * Request outside of the zone, lile fetch()
     * @param {*} endpoint deault: [zoneID, nanoid()]
     * @param {*} data request data, like http req body
     * @returns 
     */
    const request_raw = async (endpoint = [options.zoneID, nanoid()], data = {}) => {
        return new Promise(async (resolve, reject) => {
            if (debug) console.log("[requestRAW]", endpoint.join("."), data);

            if (!nats) {
                console.error("[requestRAW] NATS not connected");
                return reject("[requestRAW] NATS not connected");
            }

            try {
                const m = await nats.request(endpoint.join("."), JSON.stringify(data), { timeout: 1000 });
                const req = codec.decode(m.data);
                if (debug) console.log("[requestRAW Response]", req);
                resolve(req);
            } catch (err) {
                console.error("[requestRAW Error]", err.message);
                reject(err.message);
            }
        });
    }

    /**
     * Request a endpoint, lile fetch()
     * @param {*} endpoint deault: [nanoid()]
     * @param {*} data request data, like http req body
     * @returns 
     */
    const request = async (endpoint = [nanoid()], data = {}) => {
        return new Promise(async (resolve, reject) => {
            if (debug) console.log("[request]", endpoint, data);

            if (!nats) {
                console.error("[request] NATS not connected");
                return reject("[request] NATS not connected");
            }

            try {
                const msg = await nats.request(`${options.zoneID}.${endpoint.join(".")}`, JSON.stringify({
                    timeStamp: Date.now(),
                    deviceID: options.device_id,
                    zoneID: options.zoneID,
                    data
                }), { timeout: 1000 });
                const req = JSON.parse(codec.decode(msg.data));
                if (debug) console.log("[request Response]", req);
                resolve(req);
            } catch (err) {
                console.error("[request Error]", err.message);
                reject(err.message);
            }
        });
    }

    event.on("kinopio.connected", async (nats) => {
        if (_connect.daemon) clearInterval(_connect.daemon)
        _connect.daemon = setInterval(daemon, 5000);
    })

    _connect();
    Object.assign(handler, {
        event,
        connected,
        _var,
        serve,
        serve_raw,
        request,
        request_raw,
        decode: codec.decode,
        encode: codec.encode
    })
    return handler;
}