import path from "path";
import { BrowserWindow, dialog, shell, Menu } from "electron";
import { OVERLAY_WINDOW_OPTS } from "electron-overlay-window";
import type { ServerEvents } from "../server";
import type { Logger } from "../RemoteLogger";
import type { GameWindow } from "./GameWindow";
import { InputProxy } from "./InputProxy";

export class OverlayWindow {
  public isInteractable = false;
  public wasUsedRecently = true;
  private window?: BrowserWindow;
  // KDE Wayland only. See InputProxy for the rationale; in short, the main
  // window is focusable:false (needed for visibility above PoE2's fullscreen
  // Wayland surface), so we can't receive keyboard input directly. The proxy
  // is an invisible focusable window that grabs Wayland keyboard focus on
  // our behalf and forwards keystrokes into the main window via sendInputEvent.
  private inputProxy?: InputProxy;
  private overlayKey: string = "Shift + Space";
  private isOverlayKeyUsed = false;

  constructor(
    private server: ServerEvents,
    private logger: Logger,
    private poeWindow: GameWindow,
  ) {
    this.server.onEventAnyClient(
      "OVERLAY->MAIN::focus-game",
      this.assertGameActive,
    );
    this.poeWindow.on("active-change", this.handlePoeWindowActiveChange);
    this.poeWindow.onAttach(this.handleOverlayAttached);

    this.server.onEventAnyClient("CLIENT->MAIN::used-recently", (e) => {
      this.wasUsedRecently = e.isOverlay;
    });

    if (process.argv.includes("--no-overlay")) return;

    // On KDE Wayland, electron-overlay-window's default Linux options leave
    // the BrowserWindow focusable + with shadow + in taskbar. KWin appears
    // to treat such windows as normal app windows and skips compositing
    // them entirely when setIgnoreMouseEvents(true) is set. Match the
    // settings the standalone wayland-probe used (which DID render visibly
    // with click-through enabled) — focusable:false, skipTaskbar:true,
    // hasShadow:false.
    const isLinux = process.platform === "linux";
    this.window = new BrowserWindow({
      icon: path.join(__dirname, process.env.STATIC!, "icon.png"),
      ...OVERLAY_WINDOW_OPTS,
      ...(isLinux
        ? {
            focusable: false,
            skipTaskbar: true,
            hasShadow: false,
          }
        : {}),
      width: 800,
      height: 600,
      webPreferences: {
        allowRunningInsecureContent: false,
        webviewTag: true,
        spellcheck: false,
      },
    });

    this.window.setMenu(
      Menu.buildFromTemplate([
        { role: "editMenu" },
        { role: "reload" },
        { role: "toggleDevTools" },
      ]),
    );

    this.window.webContents.on("before-input-event", this.handleExtraCommands);
    this.window.webContents.on(
      "did-attach-webview",
      (_, webviewWebContents) => {
        webviewWebContents.on("before-input-event", this.handleExtraCommands);
      },
    );

    this.window.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url);
      return { action: "deny" };
    });

    if (isLinux) {
      this.inputProxy = new InputProxy(this.window, this.assertGameActive);
    }
  }

  loadAppPage(port: number) {
    const url =
      process.env.VITE_DEV_SERVER_URL || `http://localhost:${port}/index.html`;

    if (!this.window) {
      shell.openExternal(url);
      return;
    }

    if (process.env.VITE_DEV_SERVER_URL) {
      this.window.loadURL(url);
      this.window.webContents.openDevTools({ mode: "detach", activate: false });
    } else {
      this.window.loadURL(url);
    }
  }

  // Live cursor position. Delegates to GameWindow which uses the WaylandTracker
  // feed on Wayland (Electron's API returns frozen coords there).
  getCursorPoint(): { x: number; y: number } {
    return this.poeWindow.getCursorPoint();
  }

  assertOverlayActive = () => {
    if (!this.isInteractable) {
      this.isInteractable = true;
      this.poeWindow.activateOverlay();
      this.poeWindow.isActive = false;
      this.inputProxy?.show();
    }
  };

  assertGameActive = () => {
    if (this.isInteractable) {
      this.isInteractable = false;
      this.poeWindow.focusTarget();
      this.poeWindow.isActive = true;
      this.inputProxy?.hide();
    }
  };

  toggleActiveState = () => {
    this.isOverlayKeyUsed = true;
    if (this.isInteractable) {
      this.assertGameActive();
    } else {
      this.assertOverlayActive();
    }
  };

  updateOpts(overlayKey: string, windowTitle: string) {
    this.overlayKey = overlayKey;
    this.poeWindow.attach(this.window, windowTitle);
  }

  private handleExtraCommands = (
    event: Electron.Event,
    input: Electron.Input,
  ) => {
    if (input.type !== "keyDown") return;

    let { code, control: ctrlKey, shift: shiftKey, alt: altKey } = input;

    if (code.startsWith("Key")) {
      code = code.slice("Key".length);
    } else if (code.startsWith("Digit")) {
      code = code.slice("Digit".length);
    }

    if (shiftKey && altKey) code = `Shift + Alt + ${code}`;
    else if (ctrlKey && shiftKey) code = `Ctrl + Shift + ${code}`;
    else if (ctrlKey && altKey) code = `Ctrl + Alt + ${code}`;
    else if (altKey) code = `Alt + ${code}`;
    else if (ctrlKey) code = `Ctrl + ${code}`;
    else if (shiftKey) code = `Shift + ${code}`;

    switch (code) {
      case "Escape":
      case "Ctrl + W": {
        event.preventDefault();
        process.nextTick(this.assertGameActive);
        break;
      }
      case this.overlayKey: {
        event.preventDefault();
        process.nextTick(this.toggleActiveState);
        break;
      }
    }
  };

  private handleOverlayAttached = (hasAccess?: boolean) => {
    if (hasAccess === false) {
      this.logger.write(
        "error [Overlay] PoE2 is running with administrator rights",
      );

      dialog.showErrorBox(
        "PoE2 window - No access",
        // ----------------------
        "Path of Exile 2 is running with administrator rights.\n" +
          "\n" +
          "You need to restart Exiled Exchange 2 with administrator rights.",
      );
    } else {
      this.server.sendEventTo("broadcast", {
        name: "MAIN->OVERLAY::overlay-attached",
        payload: undefined,
      });
    }
  };

  private handlePoeWindowActiveChange = (isActive: boolean) => {
    if (isActive && this.isInteractable) {
      this.isInteractable = false;
      // PoE2 reclaimed focus (e.g. user clicked into the game area) — drop
      // the proxy so it doesn't keep stealing keyboard focus on next focus
      // change.
      this.inputProxy?.hide();
    }
    this.server.sendEventTo("broadcast", {
      name: "MAIN->OVERLAY::focus-change",
      payload: {
        game: isActive,
        overlay: this.isInteractable,
        usingHotkey: this.isOverlayKeyUsed,
      },
    });
    this.isOverlayKeyUsed = false;
  };
}
