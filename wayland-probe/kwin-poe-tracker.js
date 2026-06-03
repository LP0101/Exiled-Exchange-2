// KWin 6 script — identifies the PoE2 window, tracks geometry and focus,
// and pushes both as DBus method calls to org.exiled.ExiledExchange2 /Tracker.
// Also echoes each event via console.info (visible via journalctl --user -f
// | grep '\[EE2\]') for debugging.

const SERVICE = "org.exiled.ExiledExchange2";
const OBJECT = "/Tracker";
const IFACE = "org.exiled.ExiledExchange2.Tracker";

function isPoeWindow(w) {
  if (!w) return false;
  const cap = w.caption || "";
  const cls = (w.resourceClass || "").toLowerCase();
  return cap === "Path of Exile 2" || cls === "steam_app_2694490";
}

function fmtGeom(g) {
  if (!g) return "(no-geom)";
  return g.x + "," + g.y + " " + g.width + "x" + g.height;
}

function call(method) {
  // callDBus signature: (service, path, interface, method, ...args)
  const args = Array.prototype.slice.call(arguments, 1);
  const all = [SERVICE, OBJECT, IFACE, method].concat(args);
  callDBus.apply(null, all);
}

function emitGeometry(w) {
  const g = w.frameGeometry;
  if (!g) return;
  console.info("[EE2] -> Geometry " + fmtGeom(g));
  call("Geometry", g.x | 0, g.y | 0, g.width | 0, g.height | 0);
}

function emitFocus(focused) {
  console.info("[EE2] -> Focus focused=" + focused);
  call("Focus", !!focused);
}

function emitPresent(present) {
  console.info("[EE2] -> Present present=" + present);
  call("Present", !!present);
}

function trackPoe(w) {
  console.info("[EE2] TRACK caption='" + w.caption + "' class='" + w.resourceClass + "'");
  emitPresent(true);
  emitGeometry(w);
  emitFocus(!!w.active);
  if (w.frameGeometryChanged) {
    w.frameGeometryChanged.connect(function () {
      emitGeometry(w);
    });
  }
  if (w.closed) {
    w.closed.connect(function () {
      console.info("[EE2] PoE2 closed");
      emitPresent(false);
    });
  }
}

console.info("[EE2] tracker loaded");
call("Hello", "tracker loaded");

// Inventory pass — find PoE2 if already running.
const list = workspace.windowList ? workspace.windowList() : workspace.clientList();
let found = false;
for (let i = 0; i < list.length; i++) {
  if (isPoeWindow(list[i])) {
    trackPoe(list[i]);
    found = true;
    break;
  }
}
if (!found) {
  console.info("[EE2] PoE2 not yet running; waiting for windowAdded");
}

// PoE2 launches after script load.
const added = workspace.windowAdded || workspace.clientAdded;
if (added) {
  added.connect(function (w) {
    if (isPoeWindow(w)) {
      console.info("[EE2] ADDED-POE");
      trackPoe(w);
    }
  });
}

// Focus changes.
const activated = workspace.windowActivated || workspace.clientActivated;
if (activated) {
  activated.connect(function (w) {
    if (w && isPoeWindow(w)) emitFocus(true);
    else emitFocus(false);
  });
}
