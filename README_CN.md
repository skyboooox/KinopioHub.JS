# KinopioHub
云原生消息传递组件

JavaScript

# Roadmap

### 开发中

- Server Docker 
- 开发文档
- Web UI

### future

- 故障转移
- 就近链接
- Python
- C++ (Arduino\ESP32)


# Server

`...Docker in dev`

# Client

*完整可运行示例 `./example`*

------

**连接到服务器**

需要自行准备 NATS Server

```js
let kinopio = await client({
    servers: ["wss://demo.nats.io:8443","wss://demo.nats.io:4443"],//替换你的 NATS Server
    zoneID: "000000000000000000000000",//替换你的Zone ID，字符串，推荐是nanoid()
    //更多 option
})

/*	可选
	等待连接建立
	如果不等待，需要注意变量初始化时间点
*/
await kinopio.connected(); 

await kinopio._var("example_var_name",false); //regist a remote variable
```

------

**发布 / 订阅**

你的本地变量会在远程实时同步。
在其他地方使用时候，就像在本地一样!

> [!NOTE]
>
> 订阅可以是多处的！但是，同时发布时注意冲突。

```js
//发布, 提示: 变量会被 JSON.stringify()
kinopio.example_var_name.set(Date.now());

//订阅, .on 会监听来自远程的改动
kinopio[var_name].on((data) => {
    console.log("Received data", data);
})

```

------

**服务 / 请求**

服务类似 RESTful API

请求类似 fetch()

```js


/*
支持通配符
示例: ["Abc","*"]

在NATS中，地址数组会被转为字符串
["example", "endpoint_name"]  --> example.endpoint_name

*/
const endpoint_name = ["example", "endpoint_name"] 


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

//在别处发起请求
const received = await kinopio.request(endpoint_name, { data: `[${Date.now()}]Hello, Princess!` }); 

```

