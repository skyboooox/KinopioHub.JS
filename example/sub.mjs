import { client } from "../kinopio.mjs";

let kinopio = await client({
    servers: ["ws://server1:4222", "ws://server2:4222"],//Replace Your Server
    clientID: "000000000000000000000000",//Replace Your ID
    debug: false,
    skipVarInit: false,
    healthReport: -1,
})
await kinopio.connected();

kinopio.wrtrte.on((data) => {
    console.log("Received data", data);
})


