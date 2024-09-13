import { client } from "../kinopio.mjs";

let endpoint = ["Abc", "efg"] //Replace Your Endpoint

let kinopio = await client({
    servers: ["ws://server1:4222", "ws://server2:4222"],//Replace Your Server
    clientID: "000000000000000000000000",//Replace Your ID
    debug: true,
    skipVarInit: true,
})
await kinopio.connected();
kinopio.serve(endpoint,
    async (msg) => {
        console.log("Received data:", msg);
        return {
            status: "ok",
            data: {
                message: "Hello, Mario!"
            }
        }
    }
);

