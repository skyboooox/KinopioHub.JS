import { client } from "../kinopio.mjs";

let kinopio = await client({
    servers: ["wss://demo.nats.io:8443","wss://demo.nats.io:4443"],//Replace Your Server
    zoneID: "000000000000000000000000",//Replace Your ID
    debug: true,
})
await kinopio.connected();//wait for connection to be established

const var_name = "example_var_name";//Replace your own variable name
await kinopio._var("example_var_name", false); //regist a remote variable

kinopio[var_name].on((data) => { //.on will listen for remote changes
    console.log("Received data", data);
})


