# ![Perfect Jewelers Orb](./renderer/public/images/jeweler.png) Exiled Exchange 2 — KDE Wayland fork

## About this fork

This is a downstream fork of [Kvan7/exiled-exchange-2](https://github.com/Kvan7/exiled-exchange-2) that adds **native KDE Plasma 6 Wayland support** so PoE2 can run as a native Wayland client (and get HDR) while the overlay still works. Upstream targets Windows and X11 / XWayland-only Linux.

What this fork changes:

- **Native KDE Wayland backend.** A new `WaylandTracker` ([`main/src/windowing/WaylandTracker.ts`](main/src/windowing/WaylandTracker.ts)) loads a KWin script that reports PoE2's geometry, focus state, and cursor position via DBus, replacing the X11 `electron-overlay-window` attach (which can't see a native-Wayland PoE2 window).
- **Hotkeys via KWin's `registerShortcut`** instead of `globalShortcut.register`. KWin filters Ctrl+letter combos out of XWayland's keyboard stream, so the X11 grab never fires; binding at the compositor level is the only way to claim them.
- **Input synthesis via [`ydotool`](https://github.com/ReimuNotMoe/ydotool)** for the Ctrl+C item-copy step. Wayland clients don't see X11 `XTest`-synthesized events; ydotool writes to `/dev/uinput` at the kernel level so PoE2 receives it like a real keypress.
- **Clipboard read via `wl-paste`** (from `wl-clipboard`). Electron's `clipboard.readText()` reads the X11 CLIPBOARD selection which XWayland only lazy-mirrors from PoE2's Wayland selection.
- **Cursor hover detection** via KWin's `workspace.cursorPosChanged` signal forwarded through DBus — needed because `screen.getCursorScreenPoint()` returns frozen coords while PoE2 owns the pointer.
- **Text input forwarding for overlay panels.** The main overlay BrowserWindow has to be constructed `focusable: false` so KWin will composite it above PoE2's fullscreen surface — but that means it can't receive keyboard events. A second 1×1 invisible `focusable: true` BrowserWindow (the "InputProxy") grabs Wayland keyboard focus while a panel is interactive and forwards each keystroke into the main overlay via `webContents.insertText` / `executeJavaScript`. Lets you type into settings / search fields normally.
- **AppImage build with auto-update disabled.** The `--no-updates` flag is baked into the AppImage's `.desktop` Exec line so background update checks never run.

### Runtime requirements

- **KDE Plasma 6** (Wayland session). Plasma 5 won't work — the KWin script API is different.
- **`ydotool` + `ydotoold` user service** running before launch:
  ```bash
  sudo pacman -S ydotool          # Arch / Cachy
  sudo apt install ydotool        # Debian / Ubuntu
  systemctl --user enable --now ydotoold
  ```
- **`wl-clipboard`**:
  ```bash
  sudo pacman -S wl-clipboard
  sudo apt install wl-clipboard
  ```
- Path of Exile 2 launched as a **native Wayland client** (use Steam's Proton with `PROTON_ENABLE_WAYLAND=1` and a Proton GE / Proton hotfix build that supports it).
- The overlay itself must run **under XWayland** (`ELECTRON_OZONE_PLATFORM_HINT=x11`). The AppImage handles this for you.

### Launching

If you launch from the desktop entry, the `.desktop` file already passes the right flags. From a shell:

```bash
ELECTRON_OZONE_PLATFORM_HINT=x11 \
XDG_SESSION_TYPE=x11 \
"./Exiled Exchange 2-0.15.3.AppImage" --no-updates
```

### Known limitations

- **Start this app before Discord** (or any other Electron app that registers `Ctrl + D` — Slack, VS Code, etc.). KGlobalAccel uses first-come-first-served for global shortcut bindings: whichever process registers first wins, and later `register` calls succeed silently without actually claiming the key. So if you launch the overlay first, you can start Discord any time after and Discord's "toggle deafen" binding simply no-ops while ours keeps working. If Discord starts first, you'd need to restart this app (after closing Discord) to claim the key back. See [`WAYLAND-NATIVE-NOTES.md`](WAYLAND-NATIVE-NOTES.md) for details.
- **`Alt + letter` hotkeys won't work** — the built-in "hold Alt to hide the overlay UI" feature is disabled on Linux because ydotool's synthesized Alt confuses the detection. Use Ctrl-based hotkeys instead.
- **Some text-input keys don't forward.** Letters, digits, symbols, Backspace, Delete, arrow keys, Home, End, Enter, and Escape all work in overlay text fields. Modifier combos like `Ctrl+A` (select all), `Ctrl+C` / `Ctrl+V` / `Ctrl+X` (clipboard), and Tab focus-traversal are not forwarded — these need OS-level command dispatch that Chromium gates on window focus. Use right-click context menus or mouse for those.
- **Mouse cursor disappears over a focused number input** — a Chromium/XWayland cursor-protocol quirk with non-focusable windows. Typing still works; only the visible mouse cursor is missing while hovering the field. Comes back when you move off.
- **Screenshot-based OCR features** (heist gems) are not implemented on Wayland; they're already gated to Windows in upstream so nothing user-visible changes.
- **KDE only.** sway/Hyprland/GNOME would each need a separate compositor backend; the architecture supports it but isn't built yet.

For the full picture — every file changed, why it was changed, the architecture, troubleshooting / recovery commands, and the Phase 2 distribution plan — see [`WAYLAND-NATIVE-NOTES.md`](WAYLAND-NATIVE-NOTES.md).

---

## Upstream description

[![GitHub Downloads (specific asset, latest release)](https://img.shields.io/github/downloads/kvan7/exiled-exchange-2/latest/Exiled-Exchange-2-Setup-0.15.4.exe?style=plastic&link=https%3A%2F%2Ftooomm.github.io%2Fgithub-release-stats%2F%3Fusername%3Dkvan7%26repository%3DExiled-Exchange-2)](https://tooomm.github.io/github-release-stats/?username=kvan7&repository=Exiled-Exchange-2)
[![GitHub Tag](https://img.shields.io/github/v/tag/kvan7/exiled-exchange-2?style=plastic&label=latest%20version)](https://github.com/Kvan7/Exiled-Exchange-2/releases/latest)
[![GitHub commits since latest release (branch)](https://img.shields.io/github/commits-since/kvan7/exiled-exchange-2/latest/dev?style=plastic)](https://github.com/Kvan7/Exiled-Exchange-2/commits/dev/)
[![Translation status](https://translate.codeberg.org/widget/exiled-exchange-2/svg-badge.svg)](https://translate.codeberg.org/engage/exiled-exchange-2/)

Path of Exile 2 overlay program for price checking items, among many other loved features.

Fork of [Awakened PoE Trade](https://github.com/SnosMe/awakened-poe-trade).

The ONLY official download sites are <https://kvan7.github.io/Exiled-Exchange-2/download> or <https://github.com/Kvan7/Exiled-Exchange-2/releases>, any other locations are not official and may be malicious.

## Moving from POE1/Awakened PoE Trade

1. Download latest release from [releases](https://github.com/Kvan7/exiled-exchange-2/releases)
2. Run installer
3. Run Exiled Exchange 2
4. Launch PoE2 to generate correct files
5. Quit PoE2 and EE2 after seeing the banner popup that EE2 loaded
6. Copy `apt-data` from `%APPDATA%\awakened-poe-trade` to `%APPDATA%\exiled-exchange-2` to copy your previous settings
  - Resulting directory structure should look like this:
  - `%APPDATA%\exiled-exchange-2\apt-data\`
    - `config.json`
7. Edit `config.json` and change the value of "windowTitle": "Path of Exile" to instead be "Path of Exile 2", otherwise it will open only for poe1
8. Start Exiled Exchange 2 and PoE2

## FAQ

<https://kvan7.github.io/Exiled-Exchange-2/faq>

## Tool showcase

| Gem                                                | Rare                                                 | Unique                                                   | Currency                                                     |
| -------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| ![Gem Check](./docs/reference-images/GemCheck.png) | ![Rare Check](./docs/reference-images/RareCheck.png) | ![Unique Check](./docs/reference-images/UniqueCheck.png) | ![Currency Check](./docs/reference-images/CurrencyCheck.png) |

### Development

See [DEVELOPING.md](./DEVELOPING.md)

### Acknowledgments

- [awakened-poe-trade](https://github.com/SnosMe/awakened-poe-trade)
- [libuiohook](https://github.com/kwhat/libuiohook)
- [RePoE](https://github.com/brather1ng/RePoE)
- [poeprices.info](https://www.poeprices.info/)
- [poe.ninja](https://poe.ninja/)

![graph](https://i.imgur.com/MATqhv7.png)
