import { uIOhook, UiohookKey } from "uiohook-napi";
import type { ServerEvents } from "../server";
import type { GameConfig } from "../host-files/GameConfig";
import type { OverlayWindow } from "./OverlayWindow";

// The "hold Alt → hide overlay UI" feature is designed for X11 input where
// physical keypresses are the only source. On Linux Wayland (with our setup),
// hotkey actions synthesize Alt+C via ydotool to perform the in-game copy.
// Those kernel-level synthesized events briefly look like Alt-alone to
// uiohook and trigger makeInvisible(), hiding the overlay UI (including the
// widget we just tried to show). Skip the feature on Linux until we have
// a way to filter synthesized events from physical ones.
const ENABLE_ALT_HIDES_UI = process.platform !== "linux";

export class OverlayVisibility {
  private timerId: NodeJS.Timeout | undefined;
  private isOverlayVisible = true;

  constructor(
    private server: ServerEvents,
    private overlay: OverlayWindow,
    private gameConfig: GameConfig,
  ) {
    if (!ENABLE_ALT_HIDES_UI) return;
    uIOhook.on("keydown", (e) => {
      if (
        e.altKey &&
        !e.shiftKey &&
        !e.ctrlKey &&
        e.keycode === UiohookKey.Alt
      ) {
        this.makeInvisible();
      } else {
        this.makeVisible();
      }
    });

    uIOhook.on("keyup", (e) => {
      if (!e.altKey) {
        this.makeVisible();
      }
    });

    uIOhook.on("mousemove", (e) => {
      if (!e.altKey) {
        this.makeVisible();
      }
    });
  }

  private makeVisible() {
    if (this.isOverlayVisible && this.timerId === undefined) return;

    if (this.timerId !== undefined) {
      clearTimeout(this.timerId);
      this.timerId = undefined;
    } else {
      this.isOverlayVisible = true;
      this.server.sendEventTo("broadcast", {
        name: "MAIN->OVERLAY::visibility",
        payload: { isVisible: this.isOverlayVisible },
      });
    }
  }

  private makeInvisible() {
    if (!this.isOverlayVisible || this.timerId !== undefined) return;

    this.timerId = setTimeout(
      () => {
        this.timerId = undefined;
        this.isOverlayVisible = false;
        this.server.sendEventTo("broadcast", {
          name: "MAIN->OVERLAY::visibility",
          payload: { isVisible: this.isOverlayVisible },
        });
      },
      this.overlay.isInteractable ? 85 : 275,
    );
  }
}
