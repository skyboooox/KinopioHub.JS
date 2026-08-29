import dgram from "node:dgram";

const sharedMulticastBuses = new Map();

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createDisabledBus(error = null) {
  return {
    available: false,
    error: error ? toErrorMessage(error) : null,
    subscribe() {
      return () => {};
    },
    async send() {
      return false;
    },
    async release() {},
  };
}

export function createMulticastBus(name, { groupAddress, port }) {
  const socket = dgram.createSocket({
    type: "udp4",
    reuseAddr: true,
  });

  const bus = {
    name,
    groupAddress,
    port,
    socket,
    subscribers: new Set(),
    refCount: 0,
    ready: null,
    lastSubscriberError: null,
  };

  socket.on("message", (message, remoteInfo) => {
    for (const subscriber of [...bus.subscribers]) {
      try {
        subscriber(message, remoteInfo);
      } catch (error) {
        bus.lastSubscriberError = error;
        if (process.env.KINOPIO_LEAF_DEBUG === "1") {
          console.warn(`Kinopio multicast subscriber failed on ${name}:`, error);
        }
      }
    }
  });

  bus.ready = new Promise((resolve, reject) => {
    const handleReady = () => {
      try {
        socket.addMembership(groupAddress);
        socket.setBroadcast(false);
        socket.setMulticastLoopback(true);
        socket.setMulticastTTL(255);
        socket.unref?.();
        resolve();
      } catch (error) {
        reject(error);
      }
    };

    socket.once("error", reject);
    socket.bind(port, handleReady);
  }).catch(async (error) => {
    await new Promise((resolve) => {
      try {
        socket.close(() => resolve());
      } catch {
        resolve();
      }
    });
    throw error;
  });

  return bus;
}

export async function acquireSharedMulticastBus(name, options) {
  let bus = sharedMulticastBuses.get(name);
  const wasCached = Boolean(bus);
  if (!bus) {
    bus = createMulticastBus(name, options);
    sharedMulticastBuses.set(name, bus);
  }

  try {
    await bus.ready;
  } catch (firstError) {
    if (sharedMulticastBuses.get(name) === bus) {
      sharedMulticastBuses.delete(name);
    }

    if (!wasCached) {
      if (options.optional) return createDisabledBus(firstError);
      throw firstError;
    }

    bus = sharedMulticastBuses.get(name);
    if (!bus) {
      bus = createMulticastBus(name, options);
      sharedMulticastBuses.set(name, bus);
    }
    try {
      await bus.ready;
    } catch (secondError) {
      if (sharedMulticastBuses.get(name) === bus) {
        sharedMulticastBuses.delete(name);
      }
      if (options.optional) return createDisabledBus(secondError);
      throw secondError;
    }
  }

  bus.refCount += 1;
  let released = false;

  return {
    available: true,
    subscribe(listener) {
      bus.subscribers.add(listener);
      return () => {
        bus.subscribers.delete(listener);
      };
    },
    async send(payload) {
      await bus.ready;
      return await new Promise((resolve, reject) => {
        bus.socket.send(payload, bus.port, bus.groupAddress, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(true);
        });
      });
    },
    async release() {
      if (released) return;
      released = true;
      bus.refCount -= 1;
      if (bus.refCount > 0) {
        return;
      }

      if (sharedMulticastBuses.get(name) === bus) {
        sharedMulticastBuses.delete(name);
      }
      await new Promise(resolve => bus.socket.close(() => resolve()));
    },
  };
}
