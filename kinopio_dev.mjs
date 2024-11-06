// TODO
// reg var
// remote action eg exec
import { connect, StringCodec } from "nats.ws";
import { event, nanoid } from "skyboxtool"
import fs from "fs/promises"
let nats = null;
const codec = StringCodec();
let status = 0;

export async function client(opt) {
    let handler = {}
    const options = {
        debug: false,
        servers: [],
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
        skipVarInit: false,
        ...opt
    }
    let { debug, reconnectTimeout } = options;

    if (process?.versions?.node) {
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
            if (process?.versions?.node) {
                globalThis.nats = nats;
            } else {
                window.nats = nats;
            }
            const useTine = (Date.now() - nowTime) / 1000;
            if (debug) {

                console.info(`[Kinopio] Connected to ${nats.getServer()},Use ${useTine}s`);
            } else {
                console.log(`[Kinopio] Connected to 🍄Kinoko🍄,Use ${useTine}s`);
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
    const prepare = async () => {
        if (!options.clientID) throw new Error("No clientID");
        if (options.debug) console.log("Debug Mode Enabled")
        try {
            if (options.node) {
                const id = await fs.readFile("./id")
                options.device_id = id + "";
            } else {
                options.device_id = localStorage.getItem("device_id");
                if (!options.device_id) {
                    throw new Error("No device_id")
                }
            }
        } catch (error) {
            try {
                const id = nanoid();
                if (options.node) {
                    await fs.writeFile("./id", id)
                } else {
                    localStorage.setItem("device_id", id);

                }
                options.device_id = id;
            } catch (error) {
                console.log("Can'l init Device ID", error)
                throw new Error("Can't init Device ID")
            }
        }
    }
    async function connected() {


        if (options.skipVarInit) {
            return new Promise((resolve, reject) => {
                event.on("kinopio.connected", () => {
                    resolve(true)
                })
            })
        } else {
            return new Promise((resolve, reject) => {
                event.on("kinopio.initDone", () => {
                    resolve(true)
                })
            })
        }


    }
    async function regist() {
        console.log("getVar")
        try {
            const resp = await request_raw(["peach", "register"], {
                timeStamp: Date.now(),
                deviceID: options.device_id,
                clientID: options.clientID,
            })
            handler.clientInfo = JSON.parse(resp).data;
            if (!handler.clientInfo) {
                console.warn("This client not regist yet")
            }
        } catch (error) {
            console.log(error)
        }


    }
    async function initVar() {
        console.log(handler.clientInfo)
        if (handler.clientInfo.readVar.length > 0) {
            for (const v of handler.clientInfo.readVar) {
                handler[v.name] = {
                    on: async (cb) => {
                        nats.subscribe(v._id, {
                            callback: async (err, msg) => {
                                if (err) {
                                    console.warn("[Kinopio] Subscribe Error:", err);
                                    return;
                                }
                                const data = codec.decode(msg.data);
                                if (debug) console.log("[Kinopio] Received:", data);
                                handler[v.name].value = data.value;
                                handler[v.name].timestamp = data.timestamp;
                                cb(data);
                            }
                        })
                    }
                }
            }
        }
        if (handler.clientInfo.writeVar.length > 0) {
            for (const v of handler.clientInfo.writeVar) {

                handler[v.name] = {
                    on: async (cb) => {
                        nats.subscribe(v._id, {
                            callback: async (err, msg) => {
                                if (err) {
                                    console.warn("[Kinopio] Subscribe Error:", err);
                                    return;
                                }
                                const data = codec.decode(msg.data);
                                if (debug) console.log("[Kinopio] Received:", data);
                                handler[v.name].value = data.value;
                                handler[v.name].timestamp = data.timestamp;
                                cb(data);
                            }
                        })
                    },
                    set: async (value) => {
                        nats.publish(v._id, JSON.stringify({
                            timestamp: Date.now(),
                            value: value,
                        }));
                    }
                }



            }
        }
        event.emit("kinopio.initDone");
    }
    /**
     * No return, use .on to listen
     * @param {String} name var name
     * @param {Boolean} readonly readonly hasn't set method
     *
     * 
     */
    async function r_var(name, readonly = true) {
        
            handler[name] = {
                on: async (cb) => {
                    nats.subscribe(`${options.clientID}.${name}`, {
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
                    })
                }
            }

            if (readonly) return;

    }



    async function serve_raw(endpoint = [options.clientID, nanoid()], cb) {
        console.log("serve_raw", endpoint.join("."))
        nats.subscribe(endpoint.join("."), { callback: cb });
    }
    async function serve(endpoint = [nanoid()], cb) {
        nats.subscribe(`${options.clientID}.${endpoint.join(".")}`, {
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
    async function request(endpoint = [nanoid()], data = {}) {
        return new Promise(async (resolve, reject) => {
            if (debug) console.log("[request]", endpoint, data);

            if (!nats) {
                console.error("[request] NATS not connected");
                return reject("[request] NATS not connected");
            }

            try {
                const msg = await nats.request(`${options.clientID}.${endpoint.join(".")}`, JSON.stringify({
                    timeStamp: Date.now(),
                    deviceID: options.device_id,
                    clientID: options.clientID,
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
    async function request_raw(endpoint = [options.clientID, nanoid()], data = {}) {
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
    event.on("kinopio.connected", async (nats) => {
        if (_connect.daemon) clearInterval(_connect.daemon)
        _connect.daemon = setInterval(daemon, 5000);
        if (!options.skipVarInit) { await regist(); await initVar(); };

    })
    await prepare();
    _connect();
    Object.assign(handler, {
        event,
        connected,
        serve,
        serve_raw,
        request,
        request_raw,
        decode: codec.decode,
        encode: codec.encode
    })
    return handler;
}