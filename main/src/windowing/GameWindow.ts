import { screen, type BrowserWindow, type Rectangle } from "electron";
import { EventEmitter } from "events";
import { OverlayController, AttachEvent } from "electron-overlay-window";
import { WaylandTracker, isKdeWayland, Bounds } from "./WaylandTracker";
import { debug } from "../debug";
import type { Logger } from "../RemoteLogger";

export interface GameWindow {
  on: (event: "active-change", listener: (isActive: boolean) => void) => this;
}

const ZERO_BOUNDS: Rectangle = { x: 0, y: 0, width: 0, height: 0 };

export class GameWindow extends EventEmitter {
  private _isActive = false;
  private _isTracking = false;
  private _trackedWindow: BrowserWindow | undefined;
  private _waylandTracker: WaylandTracker | null = null;
  private _attachCbs: Array<(hasAccess: boolean | undefined) => void> = [];

  constructor(private logger?: Logger) {
    super();
    const kdeWayland = isKdeWayland();
    debug(
      `[GameWindow] isKdeWayland=${kdeWayland} ` +
        `WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY ?? "<unset>"} ` +
        `XDG_CURRENT_DESKTOP=${process.env.XDG_CURRENT_DESKTOP ?? "<unset>"}`,
    );
    if (kdeWayland && this.logger) {
      this._waylandTracker = new WaylandTracker(this.logger);
      this.logger.write(
        "info [GameWindow] KDE Wayland detected, using WaylandTracker backend",
      );
    }
  }

  get bounds(): Rectangle {
    if (this._waylandTracker) {
      return this._waylandTracker.bounds ?? ZERO_BOUNDS;
    }
    return OverlayController.targetBounds;
  }

  get isActive() {
    return this._isActive;
  }

  set isActive(active: boolean) {
    if (this.isActive !== active) {
      this._isActive = active;
      this.emit("active-change", this._isActive);
    }
  }

  get uiSidebarWidth() {
    // sidebar is 370px at 800x600
    const ratio = 370 / 600;
    return Math.round(this.bounds.height * ratio);
  }

  attach(window: BrowserWindow | undefined, title: string) {
    if (this._isTracking) return;
    this._isTracking = true;
    this._trackedWindow = window;

    if (this._waylandTracker) {
      debug(`[GameWindow] attach() title="${title}", starting WaylandTracker`);
      // electron-overlay-window normally handles initial show, click-through,
      // and alwaysOnTop in its attachByTitle path. We do them explicitly here.
      window?.setIgnoreMouseEvents(true);
      window?.setAlwaysOnTop(true, "screen-saver");
      this._waylandTracker.on("geometry", (b: Bounds) => {
        debug(`[GameWindow] geometry ${b.x},${b.y} ${b.width}x${b.height}`);
        this._trackedWindow?.setBounds(b);
      });
      this._waylandTracker.on("focus", (focused: boolean) => {
        debug(`[GameWindow] focus=${focused}`);
        this.isActive = focused;
      });
      this._waylandTracker.on("present", (present: boolean) => {
        debug(`[GameWindow] present=${present}`);
        if (present) {
          this._trackedWindow?.showInactive();
          this._fireAttach(undefined);
        } else {
          this._trackedWindow?.hide();
        }
      });
      this._waylandTracker.start().catch((err: Error) => {
        // Real error, not debug — surface unconditionally.
        console.error(`[GameWindow] WaylandTracker.start FAILED: ${err.message}`);
        this.logger?.write(
          `error [GameWindow] WaylandTracker.start failed: ${err.message}`,
        );
      });
      return;
    }

    OverlayController.events.on("focus", () => {
      this.isActive = true;
    });
    OverlayController.events.on("blur", () => {
      this.isActive = false;
    });
    OverlayController.attachByTitle(window, title, {
      hasTitleBarOnMac: true,
    });
  }

  onAttach(cb: (hasAccess: boolean | undefined) => void) {
    if (this._waylandTracker) {
      this._attachCbs.push(cb);
      if (this._waylandTracker.present) cb(undefined);
      return;
    }
    OverlayController.events.on("attach", (e: AttachEvent) => {
      cb(e.hasAccess);
    });
  }

  private _fireAttach(hasAccess: boolean | undefined) {
    for (const cb of this._attachCbs) cb(hasAccess);
  }

  screenshot() {
    if (this._waylandTracker) {
      // xdg-desktop-portal screencast would be the path forward, but it
      // prompts the user each session. OCR features (heist-gems) are
      // already gated on win32, so this is unreachable on Linux today.
      return Buffer.alloc(0);
    }
    return OverlayController.screenshot();
  }

  activateOverlay() {
    if (this._waylandTracker) {
      // On KDE Wayland the BrowserWindow is constructed focusable:false so
      // KWin will composite it while setIgnoreMouseEvents(true) is set.
      // To make it interactive we have to flip both bits.
      this._trackedWindow?.setFocusable(true);
      this._trackedWindow?.setIgnoreMouseEvents(false);
      this._trackedWindow?.focus();
      return;
    }
    OverlayController.activateOverlay();
  }

  focusTarget() {
    if (this._waylandTracker) {
      this._trackedWindow?.setIgnoreMouseEvents(true);
      this._trackedWindow?.setFocusable(false);
      return;
    }
    OverlayController.focusTarget();
  }

  async dispose(): Promise<void> {
    if (this._waylandTracker) {
      await this._waylandTracker.stop();
    }
  }

  // Push the current set of action shortcuts to the compositor-side binder.
  // On Wayland the KWin script calls registerShortcut() per entry, which is
  // the only way Ctrl+letter combos reach the app (KWin filters them out of
  // XWayland otherwise). No-op on other backends.
  setShortcuts(shortcuts: string[]): void {
    if (this._waylandTracker) {
      this._waylandTracker.setShortcuts(shortcuts).catch((err: Error) => {
        this.logger?.write(
          `error [GameWindow] setShortcuts failed: ${err.message}`,
        );
      });
    }
  }

  // Subscribe to "user pressed a registered hotkey" notifications coming from
  // the compositor. Fires with the shortcut string (e.g. "Ctrl+D"). No-op on
  // backends without compositor-side hotkey binding.
  onHotkey(cb: (shortcut: string) => void): void {
    if (this._waylandTracker) {
      this._waylandTracker.on("hotkey", cb);
    }
  }

  // Live cursor position. On Wayland we read it from the KWin script (because
  // Electron's screen.getCursorScreenPoint() returns frozen data while PoE2
  // owns the pointer). On other backends, delegate to Electron's API.
  getCursorPoint(): { x: number; y: number } {
    if (this._waylandTracker) {
      return this._waylandTracker.cursor ?? { x: 0, y: 0 };
    }
    return screen.getCursorScreenPoint();
  }
}
