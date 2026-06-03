import { screen, globalShortcut } from "electron";
import { uIOhook, UiohookKey, UiohookWheelEvent } from "uiohook-napi";
import {
  isModKey,
  KeyToElectron,
  mergeTwoHotkeys,
} from "../../../ipc/KeyToCode";
import {
  keyTapByName,
  keyToggleByName,
  keySequenceByName,
  KeyEvent,
} from "./InputSynth";
import { debug } from "../debug";
import { typeInChat, stashSearch } from "./text-box";
import { WidgetAreaTracker } from "../windowing/WidgetAreaTracker";
import { HostClipboard } from "./HostClipboard";
import { OcrWorker } from "../vision/link-main";
import type { ShortcutAction } from "../../../ipc/types";
import type { Logger } from "../RemoteLogger";
import type { OverlayWindow } from "../windowing/OverlayWindow";
import type { GameWindow } from "../windowing/GameWindow";
import type { GameConfig } from "../host-files/GameConfig";
import type { ServerEvents } from "../server";

type UiohookKeyT = keyof typeof UiohookKey;
const UiohookToName = Object.fromEntries(
  Object.entries(UiohookKey).map(([k, v]) => [v, k]),
);

// On Linux we dispatch from the WaylandTracker's KWin script (via DBus),
// which calls `registerShortcut(...)` at the compositor level. That's the
// only way Ctrl+letter combos reach the app under KDE Wayland — KWin filters
// them out of the XWayland pipeline otherwise. Electron's globalShortcut
// (XGrabKey-based) sees nothing. Side-effect: PoE2 doesn't see the key
// either, since KWin treats it as a compositor-claimed shortcut.
const USE_COMPOSITOR_HOTKEYS = process.platform === "linux";

export class Shortcuts {
  private actions: ShortcutAction[] = [];
  private actionByShortcut = new Map<string, ShortcutAction>();
  private stashScroll = false;
  private logKeys = false;
  private areaTracker: WidgetAreaTracker;
  private clipboard: HostClipboard;

  static async create(
    logger: Logger,
    overlay: OverlayWindow,
    poeWindow: GameWindow,
    gameConfig: GameConfig,
    server: ServerEvents,
  ) {
    const ocrWorker = await OcrWorker.create();
    const shortcuts = new Shortcuts(
      logger,
      overlay,
      poeWindow,
      gameConfig,
      server,
      ocrWorker,
    );
    return shortcuts;
  }

  private constructor(
    private logger: Logger,
    private overlay: OverlayWindow,
    private poeWindow: GameWindow,
    private gameConfig: GameConfig,
    private server: ServerEvents,
    private ocrWorker: OcrWorker,
  ) {
    this.areaTracker = new WidgetAreaTracker(server, overlay);
    this.clipboard = new HostClipboard(logger);

    this.poeWindow.on("active-change", (isActive) => {
      process.nextTick(() => {
        if (isActive === this.poeWindow.isActive) {
          if (isActive) {
            this.register();
          } else {
            this.unregister();
          }
        }
      });
    });

    this.server.onEventAnyClient("CLIENT->MAIN::user-action", (e) => {
      if (e.action === "stash-search") {
        stashSearch(e.text, this.clipboard, this.overlay);
      }
    });

    uIOhook.on("keydown", (e) => {
      if (!this.logKeys) return;
      const pressed = eventToString(e);
      this.logger.write(`debug [Shortcuts] Keydown ${pressed}`);
    });

    if (USE_COMPOSITOR_HOTKEYS) {
      this.poeWindow.onHotkey((shortcut) => {
        // KWin emits the shortcut in Qt format ("Ctrl+D"); our action map is
        // keyed on the app's internal format ("Ctrl + D").
        const internal = electronToInternal(shortcut);
        debug(
          `[Shortcuts] kwin-hotkey shortcut="${shortcut}" internal="${internal}" isActive=${this.poeWindow.isActive} hit=${this.actionByShortcut.has(internal)}`,
        );
        if (!this.poeWindow.isActive) return;
        const entry = this.actionByShortcut.get(internal);
        if (!entry || entry.action.type === "test-only") return;
        this.runAction(entry);
      });
    }
    uIOhook.on("keyup", (e) => {
      if (!this.logKeys) return;
      this.logger.write(
        `debug [Shortcuts] Keyup ${
          UiohookToName[e.keycode] || "not_supported_key"
        }`,
      );
    });

    uIOhook.on("wheel", (e) => {
      if (!e.ctrlKey || !this.poeWindow.isActive || !this.stashScroll) return;

      if (!isStashArea(e, this.poeWindow)) {
        if (e.rotation > 0) {
          keyTapByName("ArrowRight");
        } else if (e.rotation < 0) {
          keyTapByName("ArrowLeft");
        }
      }
    });
  }

  updateActions(
    actions: ShortcutAction[],
    stashScroll: boolean,
    logKeys: boolean,
    restoreClipboard: boolean,
    language: string,
  ) {
    this.stashScroll = stashScroll;
    this.logKeys = logKeys;
    this.clipboard.updateOptions(restoreClipboard);
    this.ocrWorker.updateOptions(language);

    const copyItemShortcut = mergeTwoHotkeys(
      "Ctrl + C",
      this.gameConfig.showModsKey,
    );
    if (copyItemShortcut !== "Ctrl + C") {
      actions.push({
        shortcut: copyItemShortcut,
        action: { type: "test-only" },
      });
    }

    const allShortcuts = new Set([
      "Ctrl + C",
      "Ctrl + V",
      "Ctrl + A",
      "Ctrl + F",
      "Ctrl + Enter",
      "Home",
      "Delete",
      "Enter",
      "ArrowUp",
      "ArrowRight",
      "ArrowLeft",
      copyItemShortcut,
    ]);

    for (const action of actions) {
      if (
        allShortcuts.has(action.shortcut) &&
        action.action.type !== "test-only"
      ) {
        this.logger.write(
          `error [Shortcuts] Hotkey "${action.shortcut}" reserved by the game will not be registered.`,
        );
      }
    }
    actions = actions.filter((action) => !allShortcuts.has(action.shortcut));

    const duplicates = new Set<string>();
    for (const action of actions) {
      if (allShortcuts.has(action.shortcut)) {
        this.logger.write(
          `error [Shortcuts] It is not possible to use the same hotkey "${action.shortcut}" for multiple actions.`,
        );
        duplicates.add(action.shortcut);
      } else {
        allShortcuts.add(action.shortcut);
      }
    }
    this.actions = actions.filter(
      (action) =>
        !duplicates.has(action.shortcut) ||
        action.action.type === "toggle-overlay",
    );

    this.actionByShortcut.clear();
    for (const entry of this.actions) {
      if (entry.action.type === "test-only") continue;
      this.actionByShortcut.set(entry.shortcut, entry);
    }

    if (USE_COMPOSITOR_HOTKEYS) {
      const qtShortcuts = Array.from(this.actionByShortcut.keys()).map(
        shortcutToElectron,
      );
      this.poeWindow.setShortcuts(qtShortcuts);
    }
  }

  private register() {
    if (USE_COMPOSITOR_HOTKEYS) return;
    for (const entry of this.actions) {
      const isOk = globalShortcut.register(
        shortcutToElectron(entry.shortcut),
        () => this.runAction(entry),
      );
      if (!isOk) {
        this.logger.write(
          `error [Shortcuts] Failed to register a shortcut "${entry.shortcut}". It is already registered by another application.`,
        );
      }
      if (entry.action.type === "test-only") {
        globalShortcut.unregister(shortcutToElectron(entry.shortcut));
      }
    }
  }

  private unregister() {
    if (USE_COMPOSITOR_HOTKEYS) return;
    globalShortcut.unregisterAll();
  }

  private runAction(entry: ShortcutAction) {
    if (this.logKeys) {
      this.logger.write(
        `debug [Shortcuts] Action type: ${entry.action.type}`,
      );
    }

    if (entry.keepModKeys) {
      const nonModKey = entry.shortcut
        .split(" + ")
        .filter((key) => !isModKey(key))[0];
      keyToggleByName(nonModKey, "up");
    } else {
      entry.shortcut
        .split(" + ")
        .reverse()
        .forEach((key) => {
          keyToggleByName(key, "up");
        });
    }

    if (entry.action.type === "toggle-overlay") {
      this.areaTracker.removeListeners();
      this.overlay.toggleActiveState();
    } else if (entry.action.type === "paste-in-chat") {
      typeInChat(entry.action.text, entry.action.send, this.clipboard);
    } else if (entry.action.type === "trigger-event") {
      this.server.sendEventTo("broadcast", {
        name: "MAIN->CLIENT::widget-action",
        payload: { target: entry.action.target },
      });
    } else if (entry.action.type === "stash-search") {
      stashSearch(entry.action.text, this.clipboard, this.overlay);
    } else if (entry.action.type === "copy-item") {
      const { action } = entry;

      const pressPosition = screen.getCursorScreenPoint();

      this.clipboard
        .readItemText()
        .then((clipboard) => {
          this.areaTracker.removeListeners();
          this.server.sendEventTo("last-active", {
            name: "MAIN->CLIENT::item-text",
            payload: {
              target: action.target,
              clipboard,
              position: pressPosition,
              focusOverlay: Boolean(action.focusOverlay),
            },
          });
          if (action.focusOverlay && this.overlay.wasUsedRecently) {
            this.overlay.assertOverlayActive();
          }
        })
        .catch(() => {});

      pressKeysToCopyItemText(
        entry.keepModKeys
          ? entry.shortcut.split(" + ").filter((key) => isModKey(key))
          : undefined,
        this.gameConfig.showModsKey,
      );
    } else if (
      entry.action.type === "ocr-text" &&
      entry.action.target === "heist-gems"
    ) {
      if (process.platform !== "win32") return;

      const { action } = entry;
      const pressTime = Date.now();
      const imageData = this.poeWindow.screenshot();
      this.ocrWorker
        .findHeistGems({
          width: this.poeWindow.bounds.width,
          height: this.poeWindow.bounds.height,
          data: imageData,
        })
        .then((result) => {
          this.server.sendEventTo("last-active", {
            name: "MAIN->CLIENT::ocr-text",
            payload: {
              target: action.target,
              pressTime,
              ocrTime: result.elapsed,
              paragraphs: result.recognized.map((p) => p.text),
            },
          });
        })
        .catch(() => {});
    }
  }
}

function pressKeysToCopyItemText(
  pressedModKeys: string[] = [],
  showModsKey: string,
) {
  let keys = mergeTwoHotkeys("Ctrl + C", showModsKey).split(" + ");
  keys = keys.filter((key) => key !== "C");
  if (process.platform !== "darwin") {
    // On non-Mac platforms, don't toggle keys that are already being pressed.
    //
    // For unknown reasons, we need to toggle pressed keys on Mac for advanced
    // mod descriptions to be copied. You can test this by setting the shortcut
    // to "Alt + any letter". They'll work with this line, but not if it's
    // commented out.
    keys = keys.filter((key) => !pressedModKeys.includes(key));
  }

  // One ordered sequence: modifiers down, C down, C up, modifiers up.
  // keySequenceByName batches into a single ydotool call on Wayland (atomic
  // delivery, ordering preserved) and falls back to per-event uiohook calls
  // on other platforms.
  const events: KeyEvent[] = [];
  for (const key of keys) events.push({ name: key, state: "down" });
  events.push({ name: "C", state: "down" });
  events.push({ name: "C", state: "up" });
  for (const key of [...keys].reverse()) events.push({ name: key, state: "up" });
  keySequenceByName(events);
}

function isStashArea(mouse: UiohookWheelEvent, poeWindow: GameWindow): boolean {
  if (
    !poeWindow.bounds ||
    mouse.x > poeWindow.bounds.x + poeWindow.uiSidebarWidth
  )
    return false;

  return (
    mouse.y > poeWindow.bounds.y + (poeWindow.bounds.height * 154) / 1600 &&
    mouse.y < poeWindow.bounds.y + (poeWindow.bounds.height * 1192) / 1600
  );
}

function eventToString(e: {
  keycode: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}) {
  const { ctrlKey, shiftKey, altKey } = e;

  let code = UiohookToName[e.keycode];
  if (!code) return "not_supported_key";

  if (code === "Shift" || code === "Alt" || code === "Ctrl") return code;

  if (ctrlKey && shiftKey && altKey) code = `Ctrl + Shift + Alt + ${code}`;
  else if (shiftKey && altKey) code = `Shift + Alt + ${code}`;
  else if (ctrlKey && shiftKey) code = `Ctrl + Shift + ${code}`;
  else if (ctrlKey && altKey) code = `Ctrl + Alt + ${code}`;
  else if (altKey) code = `Alt + ${code}`;
  else if (ctrlKey) code = `Ctrl + ${code}`;
  else if (shiftKey) code = `Shift + ${code}`;

  return code;
}

function shortcutToElectron(shortcut: string) {
  return shortcut
    .split(" + ")
    .map((k) => KeyToElectron[k as keyof typeof KeyToElectron])
    .join("+");
}

// Reverse of shortcutToElectron: "Ctrl+D" → "Ctrl + D". Built once on module
// load by inverting the KeyToElectron table.
const ELECTRON_TO_INTERNAL: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [internal, electronName] of Object.entries(KeyToElectron)) {
    m[electronName] = internal;
  }
  return m;
})();

function electronToInternal(shortcut: string) {
  return shortcut
    .split("+")
    .map((k) => ELECTRON_TO_INTERNAL[k] ?? k)
    .join(" + ");
}
