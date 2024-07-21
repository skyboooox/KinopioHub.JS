# KinopioHub
云原生消息传递组件，支持JavaScript

## Roadmap



开发中

- Server Docker 
- 开发文档
- Web UI

计划

- 故障转移
- 就近链接
- Python
- C++ (Arduino\ESP32)

# Server

`...Docker 开发中

# Client

```js
import { client } from "./kinopio.mjs";
let kinopio = await client({
    clientID: "000000000000000000000000"//替换成你的
})
//await kinopio.connected();

//发布
kinopio.YOUR_VAR_NAME.set("Hello World");

//订阅
kinopio.YOUR_VAR_NAME.on((Msg) => {
    console.log("Received data", Msg);
})
```

**services**
```js
import { client } from "./kinopio.mjs";

let endpoint=["Abc","efg"]/*
--> Abc.efg
通配符支持
eg: ["Abc","*"]
*/

kinopio.serve(endpoint,
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