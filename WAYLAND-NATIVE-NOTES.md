# KDE Wayland fork — technical notes

This document describes everything the Wayland fork adds on top of upstream Exiled Exchange 2. It is the single source of truth for *what changed*, *why*, *how to recover when state gets out of sync*, and *what comes next* (distribution plan).

For a user-facing description, see [`README.md`](README.md).

---

## 1. The problem upstream doesn't solve

Upstream targets Windows + X11 / XWayland-only Linux. Its overlay backend, [`electron-overlay-window`](https://www.npmjs.com/package/electron-overlay-window), uses `XQueryTree` on Linux to find the game window by title. That works when PoE2 itself is an X11 client (running under Wine + XWayland), but it fails the moment PoE2 is launched as a native Wayland client — which is what you have to do if you want HDR on KDE.

The pieces that break under native-Wayland PoE2:

| Layer | Why it breaks |
|---|---|
| Window detection (`attachByTitle`) | `XQueryTree` doesn't see Wayland surfaces. |
| Hotkey delivery (`globalShortcut.register`) | Uses `XGrabKey`. KWin filters Ctrl+letter combos out of XWayland's keyboard pipeline entirely when a native-Wayland window has focus. |
| Item-copy synthesis (`uiohook-napi.keyTap`) | Uses XTest. Wayland clients (PoE2) don't see XTest-synthesized events. |
| Clipboard read (`clipboard.readText`) | Reads X11 CLIPBOARD. XWayland lazy-mirrors the Wayland selection on focus change, so polling sees stale data during the action. |
| Cursor position (`screen.getCursorScreenPoint`) | Returns the XWayland-side cursor, which KWin doesn't update while PoE2 owns the pointer. Returns frozen coordinates. |
| Mouse-move events (`uiohook.on('mousemove')`) | KWin only forwards mouse moves to the focused Wayland client. uiohook on XWayland sees nothing while PoE2 has focus. |
| Click-through BrowserWindow (`setIgnoreMouseEvents(true)`) | KWin under XWayland renders a focusable + click-through BrowserWindow invisibly. The window exists but compositing skips it. |

Every one of those gets a replacement in this fork. The compositor — KWin, via a KWin script + DBus — is the source of truth instead of the X server.

---

## 2. Architecture overview

```
PoE2 (native Wayland surface)
     │
     │ keypress / cursor move / focus change
     ▼
   KWin compositor                    Electron main process (XWayland)
     │                                       │
     ├──► KGlobalAccel ──► our action       │ org.exiled.ExiledExchange2 /Tracker
     │     "exiled-exchange-2-hk-N"          │  ▲
     │     │                                 │  │ DBus method calls (sessionBus)
     │     ▼                                 │  │ (Geometry / Focus / Present /
     │   KWin script callback                │  │  Hotkey / CursorPos / Hello)
     │     │ callDBus(..., "Hotkey", "Ctrl+D")
     │     └────────────────────────────────►│  ▼
     │                                       │  WaylandTracker
     │                                       │      │
     │                                       │      ├─► GameWindow.bounds / isActive
     │                                       │      ├─► onHotkey(cb) → Shortcuts.runAction
     │                                       │      └─► cursor → OverlayWindow.getCursorPoint
     │                                       │
     │                                       │  Shortcuts.runAction("copy-item")
     │                                       │      │
     │                                       │      ├─► HostClipboard.readItemText()
     │                                       │      │     └─► wl-paste --no-newline
     │                                       │      │
     │                                       │      └─► InputSynth.keySequenceByName(...)
     │                                       │            └─► ydotool key --key-delay 30 ...
     │                                       │                  │
     ▼                                       │                  ▼
   Kernel input subsystem ◄──────────────────┴────────  /dev/uinput
     │
     └─► PoE2 receives the synthetic Ctrl+Alt+C, copies the item to its Wayland selection
              │
              ▼
       wl-paste polling picks it up, item-text IPC fires, price-check widget renders
```

Two key insights:

- KWin is bilingual — it can talk to Wayland clients (PoE2) AND XWayland clients (our overlay). It just doesn't bridge between them in most places. We use KWin's *script* facility (a JS sandbox inside KWin) as the bridge, because that's the only thing that has access to both sides.
- Input synthesis is the one place the script can't help — KWin scripts have no API for typing keys into focused clients. So we go around KWin entirely and write to `/dev/uinput` via `ydotool`.

There's a second, mostly-orthogonal flow for **keyboard input into the overlay** (typing into settings / search / browser text fields), handled by an invisible secondary BrowserWindow — the **InputProxy** (§3.17). The main overlay BrowserWindow is constructed `focusable: false` so KWin will composite it above PoE2's fullscreen surface; the trade-off is KWin never routes keyboard events to it. The InputProxy is a 1×1 transparent `focusable: true` window that grabs Wayland keyboard focus on activation and forwards each keystroke into the main overlay via `webContents.insertText` (printable chars) or `webContents.executeJavaScript` synthesising on `document.activeElement` (Backspace, Delete, arrows, Enter). Active only while an interactive panel is up; hidden when focus returns to PoE2.

---

## 3. Files changed / added

Listed by responsibility, with the change rationale and any non-obvious detail.

### 3.1 New: `main/src/windowing/WaylandTracker.ts`

The single Wayland-side backend. Three responsibilities:

1. **DBus service registration.** Registers `org.exiled.ExiledExchange2` / `/Tracker` / `org.exiled.ExiledExchange2.Tracker` with five inbound methods (`Geometry iiii`, `Focus b`, `Present b`, `Hello s`, `Hotkey s`, `CursorPos ii`). Implemented with [`dbus-next`](https://github.com/dbusjs/node-dbus-next).
2. **KWin script lifecycle.** Embeds a JS script as a template literal in `buildKwinScript(shortcuts)`. The script is written to `<userData>/kwin-poe-tracker.js`, loaded via `org.kde.KWin /Scripting Scripting.loadScript`, then started with `Script.run`. On `setShortcuts()` the script is unloaded + reloaded so a fresh closure list of `registerShortcut(...)` is installed.
3. **State storage.** Caches the latest geometry, focus state, present state, and cursor position; exposes them as getters. Emits `geometry` / `focus` / `present` / `hotkey` events on its EventEmitter base.

The KWin script itself does:

- Iterates `workspace.windowList()` for an existing PoE2 (matches by `caption === "Path of Exile 2"` OR `resourceClass === "steam_app_2694490"`).
- Subscribes to `workspace.windowAdded` for late-launched PoE2 and `workspace.windowActivated` for focus events.
- Subscribes to `workspace.cursorPosChanged` and pushes cursor coords through `callDBus(SERVICE, OBJECT, IFACE, "CursorPos", x, y)` whenever they change. Both `setInterval` and `Qt.createQmlObject` are unavailable in KWin's JS sandbox, so `cursorPosChanged` is the only mechanism that works.
- Calls `registerShortcut(name, description, defaultKey, callback)` for each entry in the embedded `SHORTCUTS` array. Callback does `callDBus(..., "Hotkey", shortcut)`. KWin assigns action names `exiled-exchange-2-hk-N` and binds them under KGlobalAccel's `kwin` component.

Race-condition hardening: `start()` returns a memoized `_startPromise`. `setShortcuts()` awaits it before doing its own unload+reload, so the initial script load and any subsequent reloads can't race on the same script file path.

### 3.2 New: `main/src/shortcuts/InputSynth.ts`

Replaces `uiohook-napi` for *synthesis* (uiohook is kept for *listening*). On Linux all `keyTap` / `keyToggle` / `keySequenceByName` calls go to `ydotool key --key-delay 30 ...`; on other platforms they fall through to `uIOhook.keyTap` / `uIOhook.keyToggle` unchanged.

Key implementation choices:

- **Batched into a single `ydotool` call per `process.nextTick`.** A small queue (`waylandQueue`) collects events fired in the same JS tick. `scheduleFlush` enqueues a `process.nextTick` callback that emits one `ydotool key ...` command for the whole sequence. This solves two problems: ordering (two concurrent `ydotool` child processes can race on the `ydotoold` socket) and atomicity (PoE2 only recognises `Ctrl+Alt+C` as the advanced-copy combo if the modifiers and `C` arrive as one clean event sequence).
- **`--key-delay 30`** — empirically PoE2 drops the modifier interpretation if `--key-delay` is below ~20 ms. 30 ms is comfortable.
- **`NAME_TO_EVDEV` table** maps our shortcut-string names (`Ctrl`, `Shift`, `Alt`, letters, digits, F1–F35, arrows, space, etc.) to Linux input event codes from `/usr/include/linux/input-event-codes.h`. Anything not in the table is silently dropped on Wayland.

### 3.3 New: `main/src/debug.ts`

Three lines of code: exports `DEBUG = !!process.env.EE2_DEBUG` and `debug(...args)`. Every diagnostic `console.log` added during development is wrapped with this so the default run is quiet. Re-enable with `EE2_DEBUG=1 npm run dev`.

### 3.4 Modified: `main/src/windowing/GameWindow.ts`

The KDE Wayland detection lives here:

```ts
function isKdeWayland() {
  return process.platform === "linux"
    && !!process.env.WAYLAND_DISPLAY
    && (process.env.XDG_CURRENT_DESKTOP || "").toUpperCase().includes("KDE");
}
```

When that returns true, the constructor instantiates a `WaylandTracker`. All public API on `GameWindow` (`bounds`, `isActive`, `attach`, `onAttach`, `screenshot`, `activateOverlay`, `focusTarget`, `setShortcuts`, `onHotkey`, `getCursorPoint`) gets a Wayland branch that delegates to the tracker; on other platforms it falls through to the original `OverlayController` calls.

`activateOverlay` on Wayland flips `setFocusable(true)` + `setIgnoreMouseEvents(false)` + `focus()` together. `focusTarget` flips them back. The focusable toggle is required because at construction we set `focusable: false` (see §3.7) — without that flip the user can't click anything in the overlay.

`screenshot()` returns `Buffer.alloc(0)` on the Wayland path. The only caller (heist-gems OCR) is already win32-gated upstream, so this is just defensive.

### 3.5 Modified: `main/src/windowing/OverlayWindow.ts`

Four changes:

1. **Construction options on Linux.** Adds `focusable: false`, `skipTaskbar: true`, `hasShadow: false` on top of `OVERLAY_WINDOW_OPTS`. Without `focusable: false`, KWin treats the BrowserWindow as a "normal" app window and skips compositing it whenever `setIgnoreMouseEvents(true)` is set — the window exists but is invisible. The standalone `wayland-probe/` scaffolding confirmed this combination produces a visible click-through window.
2. **Two `OverlayController` calls replaced** with `poeWindow.activateOverlay()` / `poeWindow.focusTarget()`. The actual platform-specific logic moved into `GameWindow` (see §3.4).
3. **InputProxy construction and lifecycle** (Linux only). After the main BrowserWindow is created, instantiate `new InputProxy(this.window, this.assertGameActive)`. The proxy is shown in `assertOverlayActive()` (right after `poeWindow.activateOverlay()`) and hidden in `assertGameActive()` (right after `poeWindow.focusTarget()`). Also hidden inside `handlePoeWindowActiveChange` when PoE2 reclaims focus by other means (e.g. user clicks the game area). See §3.17 for the proxy itself.

### 3.6 Modified: `main/src/windowing/OverlayVisibility.ts`

The entire "hold Alt to hide overlay UI" feature is gated off on Linux:

```ts
const ENABLE_ALT_HIDES_UI = process.platform !== "linux";
```

Reason: ydotool's synthesized `Alt down` (between `D up` and `C down` during a Ctrl+D price-check) briefly looks like Alt-alone to uiohook, which trips `makeInvisible()` and hides every widget for ~275 ms — exactly when the price-check widget is trying to render. There's no clean way to filter "Alt from ydotool" vs "Alt from user," so the feature is just off. Bind hotkeys to Ctrl-based combos instead of Alt-based.

### 3.7 Modified: `main/src/windowing/WidgetAreaTracker.ts`

The "hold modifier + hover widget to keep it open" UX rewritten for Wayland. The vanilla model relies on uiohook seeing mousemove and `screen.getCursorScreenPoint()` returning live coords. Neither works under our setup. Replaced with:

- **`uIOhook.keyup`** on Linux drives dismiss instead of mousemove. When the held modifier is released and the overlay is NOT yet interactable, fire `hide-exclusive-widget`. Modifier keys (Ctrl/Alt/Shift) are the one thing uiohook DOES see on our setup.
- **`setInterval(pollCursor, 50)`** polls `OverlayWindow.getCursorPoint()` (which uses the WaylandTracker DBus feed). When the cursor enters the widget area, calls `assertOverlayActive()`. After that, the next keyup of the held modifier sees `isInteractable === true` and skips dismiss — widget persists until the user closes it.
- `from` and `area` continue to be stored in scaled coords for the (unused-on-Wayland) uiohook mousemove path. A separate `areaLogical` is stored unscaled because `screen.getCursorScreenPoint` / KWin's `cursorPos` use logical coords.

### 3.8 Modified: `main/src/shortcuts/Shortcuts.ts`

On Linux, dispatch comes from `poeWindow.onHotkey(...)` instead of `globalShortcut.register(...)`. The runtime gate:

```ts
const USE_COMPOSITOR_HOTKEYS = process.platform === "linux";
```

- `updateActions(...)` ends with `this.poeWindow.setShortcuts(qtShortcuts)` which pushes the list to `WaylandTracker` and triggers a script reload.
- A `electronToInternal("Ctrl+D")` helper inverts `shortcutToElectron("Ctrl + D")` so the hotkey strings KWin emits (Qt format) map back to the app's internal format keyed in `actionByShortcut`.
- `register()` / `unregister()` early-return on Linux — `globalShortcut.register` doesn't see Ctrl+letter combos on this path anyway.

### 3.9 Modified: `main/src/shortcuts/HostClipboard.ts`

`spawnSync("wl-paste", ["--no-newline"], ...)` replaces `clipboard.readText()` on Linux. `wl-copy` replaces `clipboard.writeText()`. Electron's Chromium clipboard reads the X11 selection which only syncs from Wayland on focus change; polling sees stale data. `wl-paste` reads the live Wayland selection directly.

### 3.10 Modified: `main/src/AppUpdater.ts`

`--no-updates` now skips both the 16-hour `setInterval(check, ...)` loop AND the `checkAtStartup()` call. With the flag, AutoUpdater installs no timers and makes no network requests at app startup. Manual "check for update" from the UI still works.

### 3.11 Modified: `main/src/main.ts`

One line: `new GameWindow(logger)` instead of `new GameWindow()`. The Logger is needed by WaylandTracker for renderer-visible diagnostic messages.

### 3.12 Modified: `main/electron-builder.yml`

```yaml
appImage:
  executableArgs:
    - "--sandbox"
    - "--no-updates"
```

`--no-updates` is appended to the `.desktop` Exec line so AppImage launches always pass it.

### 3.13 Modified: `main/build/script.mjs`

`'x11'` added to the esbuild `external` list. `dbus-next` has an unused optional `require('x11')` for a rare DBus-via-X11 transport mode; without the external mark, esbuild refuses to bundle because the dep isn't installed.

### 3.14 Modified: `main/package.json`

Adds `dbus-next` as a runtime dependency. Pure JS, no native build step.

### 3.15 Modified: `renderer/src/web/price-check/PriceCheckWindow.vue`

`handleItemPaste(...)` and `queuePricesFetch()` wrapped in a `try { ... } catch (err) { console.error("[PriceCheck] handler bailed:", err) }`. This was added during debugging but kept as a real safety net — without it, an unhandled exception in price-checking silently dropped the widget render without any console signal.

### 3.16 New: `wayland-probe/`

Standalone Electron + DBus scaffolding used during development to verify each capability (compositing, setBounds, click-through, hotkey delivery, KWin scripting, DBus IPC) independently before integrating into the main app. Kept in the repo as a reference / diagnostic tool. Can be deleted if disk space matters; nothing in the shipping product depends on it.

### 3.17 New: `main/src/windowing/InputProxy.ts`

The keyboard-input bridge into the focusable:false main overlay. A 1×1 transparent `focusable: true` BrowserWindow positioned at the screen origin, hidden by default, shown only when an interactive panel is up.

**Why it exists.** The main overlay's `focusable: false` is load-bearing for visibility — without it, KWin treats us as a peer app window and PoE2's fullscreen surface stacks above us. The cost is that KWin never grants keyboard focus to a focusable:false window, so a click into a text input lands the visual cursor (mouse-driven selection still works) but typing produces nothing. `setFocusable(true)` at runtime doesn't repair this — Electron's flag flips but X11 `WM_HINTS.input=False` persists in KWin's grant table. Single-window approaches with `type: 'notification'`, aggressive `setAlwaysOnTop("screen-saver")`, the KWin-script `keepAbove` flag, and `moveTop()` were all tested and none let an XWayland window stack above PoE2's Wayland-native fullscreen surface; only `focus()` reliably did, and `focus()` requires focusable:true.

**Why two windows.** Splitting the two concerns onto separate windows lets each be configured optimally. Main overlay stays focusable:false (visible always, click-through). Proxy is focusable:true (always Wayland-focusable, never visible because it's 1×1 transparent at 0,0).

**How forwarding works.** The proxy's `webContents` has a `before-input-event` handler that fires for every key. For each key:

1. **Printable single-char keys with no Ctrl/Alt/Meta modifier** (letters, digits, punctuation — including Shift+letter for capitals). Routed via `target.webContents.insertText(input.key)`. `insertText` inserts into the focused DOM element regardless of OS-level window focus, which is what we need since the main is never OS-focused.
2. **`Escape`.** Routed to the `onEscape` callback passed in at construction (wired to `OverlayWindow.assertGameActive`), so the panel dismisses just like upstream's `handleExtraCommands` Escape path.
3. **Special keys** (`Backspace`, `Delete`, `ArrowLeft`/`Right`, `Home`, `End`, `Enter`, and `ArrowUp`/`Down` on `<input type="number">`). Routed via `target.webContents.executeJavaScript(...)` with a small IIFE that finds `document.activeElement`, detects whether it supports the selection API (`<input type="number">` and others throw `InvalidStateError` on `selectionStart`), and either:
   - Mutates `el.value` via `setRangeText` + dispatches an `input` event (Vue's v-model listens for `input`, so the binding updates) on selection-supporting inputs.
   - Falls back to `el.value = ...slice...` for inputs that reject the selection API. The fallback supports Backspace and (on number inputs) ArrowUp/Down increment/decrement respecting `step`/`min`/`max`. Delete, arrow Left/Right, Home, End become no-ops on these inputs because there's no cursor position to act on.
   - For Enter: textareas insert a newline; regular inputs dispatch a synthetic `keydown` so form-level Enter handlers can react.

**Why not `sendInputEvent`.** Electron docs explicitly require the BrowserWindow be focused for `sendInputEvent` to deliver. Our main never is. `insertText` + `executeJavaScript` route through Chromium layers that don't have that restriction.

**Not yet covered.** Modifier combos (Ctrl+A, Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+Z) — these are normally handled by the browser's OS-level command dispatcher, which is gated on window focus. Tab focus traversal also doesn't propagate through `insertText`. See §6.

---

## 4. Runtime dependencies

Beyond standard Electron / Chromium:

| Dependency | Why | How to install |
|---|---|---|
| **KDE Plasma 6** (Wayland session) | KWin scripting API, KGlobalAccel, `workspace.cursorPosChanged`. Plasma 5 won't work. | OS-level |
| **`ydotool` + `ydotoold` user service** | Kernel-level input synthesis (Ctrl+Alt+C → game) | `sudo pacman -S ydotool` (Arch) / `sudo apt install ydotool` (Debian), then `systemctl --user enable --now ydotoold` |
| **`wl-clipboard`** (`wl-paste` + `wl-copy`) | Reads/writes the Wayland selection directly | `sudo pacman -S wl-clipboard` / `sudo apt install wl-clipboard` |
| **`dbus-next`** npm package | DBus client for KGlobalAccel + KWin scripting + our own service registration | `npm install` from `main/` — already pinned in package.json |
| **PoE2 launched as a native Wayland client** | The whole point — gets HDR | `PROTON_ENABLE_WAYLAND=1` with a recent Proton GE / hotfix build |

The overlay process itself must run **under XWayland**: `ELECTRON_OZONE_PLATFORM_HINT=x11` in the env. The AppImage's `.desktop` Exec line handles this.

---

## 5. Operational caveats

### 5.1 First-come-first-served KGlobalAccel bindings

KWin's KGlobalAccel grants a key binding to the first process that successfully registers for it. Subsequent `register` calls succeed silently without actually claiming the key.

Practical implication: launch this overlay before any other Electron app that grabs `Ctrl + D` (Discord's "toggle deafen" being the most common conflict). Once we own the binding, those other apps' attempts no-op. If they win the race, restart this overlay after closing them.

### 5.2 The Alt-letter problem

Don't bind hotkeys to Alt+letter combinations. See §3.6.

### 5.3 Recovering from KGlobalAccel state desync

KGlobalAccel keeps a persistent registry at `~/.config/kglobalshortcutsrc`. If you ever see "Ctrl+D moves my character in PoE" with the app running (meaning KWin isn't intercepting the key for us), something has scrambled either the registry or KWin's in-memory grab table. Recovery steps:

```bash
# 1. Stop the overlay
pkill -f "Exiled Exchange 2"   # or just close it

# 2. Unregister all of our actions (they'll be recreated on next launch)
for action in exiled-exchange-2-hk-0 exiled-exchange-2-hk-1 \
              exiled-exchange-2-hk-2 exiled-exchange-2-hk-3 \
              exiled-exchange-2-hk-4; do
  qdbus org.kde.kglobalaccel /kglobalaccel \
    org.kde.KGlobalAccel.unregister kwin "$action"
done

# 3. Wipe stale entries in the persistent config
sed -i.bak '/^exiled-exchange-2/d' ~/.config/kglobalshortcutsrc

# 4. If a competing Electron app is squatting on the keys, clean its component too
qdbus org.kde.kglobalaccel /component/org_chromium_Chromium \
  org.kde.kglobalaccel.Component.cleanUp

# 5. If grab table is still desynced, restart kglobalacceld (auto-respawns)
pkill -f kglobalacceld

# 6. Relaunch the overlay (before any other Electron app)
```

In the rare case all of that still doesn't help: log out and back in. That fully rebuilds KWin's grab table from the cleaned config.

### 5.4 Diagnostic commands

Quick reference for poking at the running state:

```bash
# Who currently owns a given key?
# Qt encoding: Ctrl=0x04000000, Alt=0x08000000, Shift=0x02000000
#   Ctrl+D     = 0x04000044 = 67108932
#   Ctrl+Space = 0x04000020 = 67108896
#   F5         = 0x01000034 = 16777268
qdbus --literal org.kde.kglobalaccel /kglobalaccel \
  org.kde.KGlobalAccel.getGlobalShortcutsByKey 67108932

# Our actions registered under the kwin KGlobalAccel component
qdbus --literal org.kde.kglobalaccel /component/kwin \
  org.kde.kglobalaccel.Component.shortcutNames | tr ',' '\n' | grep exiled

# Programmatically fire a hotkey (tests that the script callback wiring
# is alive, independent of whether KWin's actual grab is installed)
qdbus org.kde.kglobalaccel /component/kwin \
  org.kde.kglobalaccel.Component.invokeShortcut exiled-exchange-2-hk-1

# Is our KWin script currently loaded?
qdbus org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded \
  ~/.config/exiled-exchange-2/kwin-poe-tracker.js

# Inspect our DBus service (qdbus output is incomplete here; use busctl)
busctl --user introspect org.exiled.ExiledExchange2 /Tracker \
  org.exiled.ExiledExchange2.Tracker

# Watch global-shortcut signals (verify your keypresses ARE reaching KWin)
dbus-monitor --session \
  "interface='org.kde.kglobalaccel.Component',member='globalShortcutPressed'"

# Tail KWin's script log (useful when probing what's available in the JS sandbox)
journalctl --user -f --output=cat | grep "\[EE2\]"
```

### 5.5 Re-enabling debug logs

The fork wraps all session-debug `console.log` calls in `debug(...)` from `main/src/debug.ts`. To turn them all back on:

```bash
EE2_DEBUG=1 \
ELECTRON_OZONE_PLATFORM_HINT=x11 \
XDG_SESSION_TYPE=x11 \
npm run dev
```

That re-enables `[WaylandTracker]`, `[GameWindow]`, `[Shortcuts]`, `[InputSynth]`, `[ClipboardPoller]`, and `[AreaTracker]` lines.

---

## 6. Known limitations

- **`Alt + letter` hotkeys** — disabled (§3.6).
- **Screenshot / OCR features** (heist gems) — not implemented on Wayland. The only existing caller is already win32-gated upstream, so no user-visible regression.
- **Discord race for `Ctrl + D`** — §5.1.
- **Orphan KGlobalAccel entries on rebind** — the `hk-N` action names reshuffle when shortcut count changes, leaving an idle entry behind. Cosmetic, doesn't affect functionality.
- **Mouse cursor disappears over focused `<input type="number">`** — a Chromium/XWayland cursor-protocol quirk with focusable:false windows. The cursor renegotiation that fires when a number input gains focus is dropped. Cursor reappears when leaving the input. Typing still works; only the visible cursor is missing. Not caused by the InputProxy split — reproduces with the proxy disabled too.
- **Modifier combos (Ctrl+A, Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+Z) in overlay text fields** — not forwarded. These are normally dispatched by the browser's OS command path, which requires window focus. Clipboard ops also need a route to the Wayland selection. Workaround: copy text outside the overlay or rely on right-click context menus.
- **Tab key for focus traversal in overlay panels** — currently ignored by the InputProxy. Use the mouse to switch fields.
- **Forwarding hover steals keyboard from PoE2 briefly** — when the cursor enters a price-check widget area, `assertOverlayActive` triggers `inputProxy.show()` which moves Wayland keyboard focus to the proxy. PoE2 stops responding to keystrokes for that interval. Reverts on cursor leave. Side effect of the simpler "always show proxy when interactive" hook; renderer-side focus tracking could narrow the window if it ever matters.
- **KDE only** — sway / Hyprland / GNOME each need their own compositor backend (foreign-toplevel-management protocol on wlroots, GNOME extension on GNOME). The architecture supports it but isn't built.
- **HDR + multi-monitor edge cases** — unverified, expected to be fine on KWin 6.

---

## 7. Phase 2: distribution as a downstream fork

Goal: maintain this fork as a long-lived branch over upstream and publish a fresh AppImage on every upstream update.

### 7.1 Repository layout

- **Fork**: `<you>/exiled-exchange-2` on GitHub.
- **Branches**:
  - `master` — clean mirror of `upstream/master`, no local changes.
  - `wayland` — long-lived branch with the Wayland patches. Rebased onto `master` whenever upstream updates.
  - `release/*` tags pushed by the build workflow (e.g. `release/0.15.3+wayland.1`).
- **Remotes**:
  ```bash
  git remote add upstream https://github.com/Kvan7/exiled-exchange-2.git
  git remote set-url --push upstream DISABLE   # safety, never push to upstream
  ```

### 7.2 Sync workflow — `.github/workflows/sync-upstream.yml`

Runs on cron (recommend daily at 06:00 UTC). Fetches upstream, fast-forwards `master`, attempts to rebase `wayland` onto the new `master`. If the rebase fails, the workflow fails — surfaces visibly instead of force-pushing a broken rebase.

```yaml
on:
  schedule:
    - cron: "0 6 * * *"
  workflow_dispatch:
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0, ref: master }
      - run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git remote add upstream https://github.com/Kvan7/exiled-exchange-2.git
          git fetch upstream master
          git merge --ff-only upstream/master
          git push origin master
      - run: |
          git fetch origin wayland:wayland
          git checkout wayland
          if git rebase master; then
            git push --force-with-lease origin wayland
          else
            echo "::error::Wayland branch needs manual rebase"
            exit 1
          fi
```

### 7.3 Build workflow — `.github/workflows/build-appimage.yml`

Runs whenever `wayland` is pushed (so it fires both on manual changes AND on successful sync rebases). Builds renderer + main, packages the AppImage, publishes as a GitHub release.

```yaml
on:
  push:
    branches: [wayland]
  workflow_dispatch:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { ref: wayland, fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: cd renderer && npm install && npm run make-index-files && npm run build
      - run: cd main && npm install && npm run build && npm run package
      - name: Compute release tag
        id: tag
        run: |
          VERSION=$(node -p "require('./main/package.json').version")
          DATE=$(date -u +%Y%m%d)
          SHA=$(git rev-parse --short HEAD)
          echo "tag=v${VERSION}+wayland.${DATE}.${SHA}" >> $GITHUB_OUTPUT
      - name: Publish release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ steps.tag.outputs.tag }}
          name: ${{ steps.tag.outputs.tag }}
          files: main/dist/*.AppImage
          prerelease: true
```

### 7.4 Build-job preflight checklist

- `dbus-next` is non-native. `uiohook-napi` and `electron-overlay-window` ARE native — `electron-builder` with `npmRebuild: false` (current setting) uses the prebuilt binaries from npm. Works on modern glibc. If you need older distros, flip `npmRebuild: true` and install build deps in the runner.
- Upstream's renderer requires `npm run make-index-files` before `build`; don't skip it.
- `electron-builder` downloads electron at ~125 MB during the build; cache it on `~/.cache/electron-builder` keyed on the electron version from `package.json` to keep builds fast.
- The `--no-updates` flag in `electron-builder.yml` is already on `wayland`. Verify each rebase doesn't drop it (low risk — file is rarely touched upstream).

### 7.5 Patch hygiene

- Keep `wayland` commits squashable. One logical change per commit; descriptive messages. Painless rebase onto upstream.
- All temp-debug additions go through `debug(...)` from `main/src/debug.ts`. Keeps the diff vs. upstream signal-only.
- Re-verify the `NAME_TO_EVDEV` table after any `uiohook-napi` major version bump — they sometimes adjust keycode enums.

### 7.6 Risks

- **Upstream adds their own Wayland support.** Watch their PRs. If they do, contribute back and retire this fork.
- **`dbus-next` maintainership.** Sparsely updated. If it breaks on a future Node/Electron combo, candidates are `node-dbus` or a small in-house client (we use about six methods).
- **Plasma 7 / KWin 7 API breakage.** `workspace.cursorPosChanged`, `registerShortcut`, `workspace.windowList`, and the `org.kde.kwin.Scripting` DBus surface are all things KDE could change. Pin a known-good Plasma version range in the AppImage's release notes.

### 7.7 Out of scope

- Auto-merging upstream into `wayland` (too risky — sync workflow only fast-forwards `master`, surfaces rebase failure).
- AppImage signing — users can verify by checksum or by building from source.
- sway / Hyprland / GNOME builds — same architecture would work, not implemented.
