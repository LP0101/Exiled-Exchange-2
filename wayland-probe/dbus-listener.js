const dbus = require("dbus-next");
const { Interface, method } = dbus.interface;

const SERVICE = "org.exiled.ExiledExchange2";
const OBJECT = "/Tracker";
const IFACE = "org.exiled.ExiledExchange2.Tracker";

function ts() {
  return new Date().toISOString().slice(11, 23);
}
function log(...args) {
  console.log(`[listener ${ts()}]`, ...args);
}

class TrackerInterface extends Interface {
  Geometry(x, y, w, h) {
    log(`Geometry x=${x} y=${y} w=${w} h=${h}`);
  }
  Focus(focused) {
    log(`Focus focused=${focused}`);
  }
  Present(present) {
    log(`Present present=${present}`);
  }
  Hello(msg) {
    log(`Hello "${msg}"`);
  }
}

TrackerInterface.configureMembers({
  methods: {
    Geometry: { inSignature: "iiii", outSignature: "" },
    Focus: { inSignature: "b", outSignature: "" },
    Present: { inSignature: "b", outSignature: "" },
    Hello: { inSignature: "s", outSignature: "" },
  },
});

async function main() {
  const bus = dbus.sessionBus();
  const iface = new TrackerInterface(IFACE);
  bus.export(OBJECT, iface);
  await bus.requestName(SERVICE);
  log(`registered ${SERVICE} ${OBJECT} ${IFACE}`);
  log("waiting for KWin script calls. Ctrl+C to quit.");
}

main().catch((err) => {
  console.error("[listener] fatal:", err);
  process.exit(1);
});
