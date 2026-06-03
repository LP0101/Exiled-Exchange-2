const { app, BrowserWindow, globalShortcut, screen } = require("electron");
const path = require("path");
const dbus = require("dbus-next");
const { Interface } = dbus.interface;

const SERVICE = "org.exiled.ExiledExchange2";
const OBJECT = "/Tracker";
const IFACE = "org.exiled.ExiledExchange2.Tracker";

const SIZE = { width: 600, height: 300 };
const ANCHOR_OFFSET = { x: 100, y: 100 };

let win;
let clickThrough = true;
let lastPoeBounds = null;
let lastFocus = null;

function ts() {
  return new Date().toISOString().slice(11, 23);
}
function log(...args) {
  console.log(`[probe ${ts()}]`, ...args);
}

function placeOverPoe(poe) {
  if (!win || !poe) return;
  const target = {
    x: poe.x + ANCHOR_OFFSET.x,
    y: poe.y + ANCHOR_OFFSET.y,
    width: SIZE.width,
    height: SIZE.height,
  };
  win.setBounds(target);
  const actual = win.getBounds();
  const ok =
    actual.x === target.x &&
    actual.y === target.y &&
    actual.width === target.width &&
    actual.height === target.height;
  log(
    `placeOverPoe asked=${target.x},${target.y} got=${actual.x},${actual.y} ${actual.width}x${actual.height} match=${ok}`,
  );
}

function createWindow() {
  win = new BrowserWindow({
    x: 0,
    y: 0,
    width: SIZE.width,
    height: SIZE.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.setIgnoreMouseEvents(clickThrough);
  win.loadFile(path.join(__dirname, "probe.html"));

  win.once("ready-to-show", () => {
    win.showInactive();
    log(`window ready, awaiting PoE geometry from KWin`);
    if (lastPoeBounds) placeOverPoe(lastPoeBounds);
  });
}

class TrackerInterface extends Interface {
  Geometry(x, y, w, h) {
    log(`<- Geometry x=${x} y=${y} w=${w} h=${h}`);
    lastPoeBounds = { x, y, width: w, height: h };
    placeOverPoe(lastPoeBounds);
  }
  Focus(focused) {
    if (focused === lastFocus) return;
    lastFocus = focused;
    log(`<- Focus focused=${focused}`);
    if (win) win.webContents.send?.("focus", focused);
  }
  Present(present) {
    log(`<- Present present=${present}`);
    if (!present) lastPoeBounds = null;
  }
  Hello(msg) {
    log(`<- Hello "${msg}"`);
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

async function startDbus() {
  const bus = dbus.sessionBus();
  const iface = new TrackerInterface(IFACE);
  bus.export(OBJECT, iface);
  await bus.requestName(SERVICE);
  log(`DBus service registered: ${SERVICE} ${OBJECT}`);
}

app.whenReady().then(async () => {
  log(`electron=${process.versions.electron} chrome=${process.versions.chrome}`);
  log(
    `DISPLAY=${process.env.DISPLAY} WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY ?? "<unset>"} ` +
      `OZONE_HINT=${process.env.ELECTRON_OZONE_PLATFORM_HINT ?? "<unset>"}`,
  );
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  for (let i = 0; i < displays.length; i++) {
    const d = displays[i];
    log(
      `display[${i}] id=${d.id}${d.id === primary.id ? " (primary)" : ""} ` +
        `bounds=${d.bounds.x},${d.bounds.y} ${d.bounds.width}x${d.bounds.height} ` +
        `workArea=${d.workArea.x},${d.workArea.y} ${d.workArea.width}x${d.workArea.height} ` +
        `scale=${d.scaleFactor}`,
    );
  }

  try {
    await startDbus();
  } catch (err) {
    log(`DBus registration failed: ${err.message}`);
    log("the KWin script will have nothing to call into. Continuing anyway.");
  }

  createWindow();

  const r1 = globalShortcut.register("F8", () => {
    clickThrough = !clickThrough;
    win.setIgnoreMouseEvents(clickThrough);
    log(`F8: click-through=${clickThrough}`);
  });
  log(`registered F8=${r1}`);

  const r2 = globalShortcut.register("F9", () => {
    log("F9 ping (globalShortcut delivered)");
  });
  log(`registered F9=${r2}`);

  const r3 = globalShortcut.register("CommandOrControl+Shift+Q", () => {
    log("quit hotkey");
    app.quit();
  });
  log(`registered Ctrl+Shift+Q=${r3}`);
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => app.quit());
