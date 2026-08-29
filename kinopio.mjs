// Public entrypoint for kinopio-hub. The implementation lives in lib/hub and
// lib/shared; this file only re-exports the stable surface.
export { KinopioHub, KINOPIO_STATE_EVENT } from "./lib/hub/hub.mjs";
export { KinopioHub as default } from "./lib/hub/hub.mjs";
