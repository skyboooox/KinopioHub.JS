# KinopioHub
 cloud native messaging component

# Roadmap

### in dev

- Server Docker 
- dev guide
- Web UI

### future

- Failover
- Geo-awareness (Nearby Link)
- Python
- C++ (Arduino\ESP32)


# Server

`...Docker in dev`

# Client

```js
import { client } from "./kinopio.mjs";
let kinopio = await client({
    clientID: "000000000000000000000000"//Replace Your ID
})
//await kinopio.connected();

//Pub
kinopio.YOUR_VAR_NAME.set("Hello World");

//Sub
kinopio.YOUR_VAR_NAME.on((Msg) => {
    console.log("Received data", Msg);
})
```

**services**
```js
import { client } from "./kinopio.mjs";

let endpoint=["Abc","efg"]/*
--> Abc.efg
Support wildcard
eg: ["Abc","*"]
*/

kinopio.serve_raw(endpoint,
    async (err, msg) => {
        if (err) {
            console.warn("[Peach] Subscribe Error:", err);
            return;
        }

        console.log("Received data:", msg.subject, kinopio.decode(msg.data));
        msg.respond(
            kinopio.encode({
                status: "ok",
                data: {
                    message: "Hello, Mario!"
                }
            })
        );

    }
);


const rev = await kinopio.request(endpoint,{data:"Hello,Princess!"});
console.log("REV":rev)
```
!@