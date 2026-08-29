// Hub logger. error and warn always print; info and debug are gated behind
// the hub's debug flag (2.1.x hid warnings unless debug was on, which made
// every fallback path silent in production).

export function createLogger(isDebugEnabled) {
  return function log(level, message, ...args) {
    if ((level === "info" || level === "debug" || level === undefined) && !isDebugEnabled()) {
      return;
    }

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [KinopioHub]`;

    switch (level) {
      case "error":
        console.error(`${prefix} ERROR:`, message, ...args);
        break;
      case "warn":
        console.warn(`${prefix} WARN:`, message, ...args);
        break;
      case "info":
        console.info(`${prefix} INFO:`, message, ...args);
        break;
      default:
        console.log(`${prefix} DEBUG:`, message, ...args);
    }
  };
}
