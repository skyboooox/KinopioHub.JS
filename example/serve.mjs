import { client } from "../kinopio.mjs";

let kinopio = await client({
    servers: ["wss://demo.nats.io:8443","wss://demo.nats.io:4443"],//Replace Your Server
    zoneID: "000000000000000000000000",//Replace Your ID
    debug: true,
})
await kinopio.connected();
const endpoint_name = ["example", "endpoint_name"] //Replace Your Endpoint

kinopio.serve(endpoint_name,
    async (msg) => {
        console.log("Received data:", msg);
        return {
            status: "ok",
            data: {
                message: `[${Date.now()}]Hello, Mario!`
            }
        }
    }
);

