import { client } from "../kinopio.mjs";

let endpoint = ["Abc", "efg"] //Replace Your Endpoint

let kinopio = await client({
    servers: ["ws://server1:4222", "ws://server2:4222"],//Replace Your Server
    clientID: "000000000000000000000000",//Replace Your ID
    debug: true,
    skipVarInit: true,
})
await kinopio.connected();

setInterval(async () => {
    console.log("Requesting data from server")
    const rev = await kinopio.request(endpoint, { data: "Hello,Princess!" });
    console.log("REV", rev)
}, 1000);