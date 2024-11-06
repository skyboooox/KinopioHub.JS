import { client } from "../kinopio.mjs";

let kinopio = await client({
    servers: ["wss://demo.nats.io:8443","wss://demo.nats.io:4443"],//Replace Your Server
    zoneID: "000000000000000000000000",//Replace Your ID
    debug: true,
})
await kinopio.connected(); //wait for connection to be established

await kinopio._var("example_var_name",false); //regist a remote variable


setInterval(() => {
    kinopio.example_var_name.set(Date.now()); //publish, NOTICE: the value can be JSON.stringify()
}, 1);


