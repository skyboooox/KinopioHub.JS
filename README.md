# KinopioHub
Cloud Native Messaging Component

with JavaScript

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

*Full example in `./example`*

------

**Setup a client**

Need a NATS server

```js
let kinopio = await client({
    servers:  ["wss://demo.nats.io:8443","wss://demo.nats.io:4443"],//Replace Your NATS Server
    zoneID: "000000000000000000000000",//String, Replace Your ID, recommend nanoid()
    //more option
})

/*	optional
	wait for connection to be established
	If not to wait, you need to be aware of the variable initialization time point
*/
await kinopio.connected(); 

await kinopio._var("example_var_name",false); //regist a remote variable
```

------

**Publish / Subscribe**

Your local variables will publish in real time
as if they were local when you use them elsewhere!

> [!NOTE]
>
> Subscribe can be multiple! but, Watch out for conflicts when publish at the same time.

```js
//publish, NOTICE: the value can be JSON.stringify()
kinopio.example_var_name.set(Date.now());

//subscribe, .on will listen for remote changes
kinopio[var_name].on((data) => {
    console.log("Received data", data);
})

```

------

**Serve / Request**

Serve like RESTful API

Request like fetch()

```js


/*
Support wildcard
eg: ["Abc","*"]

Array will convert to string in NATS
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

//make a Request
const received = await kinopio.request(endpoint_name, { data: `[${Date.now()}]Hello, Princess!` }); 

```


