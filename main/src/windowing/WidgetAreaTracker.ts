import { Rectangle, Point, screen } from "electron";
import {
  uIOhook,
  UiohookKeyboardEvent,
  UiohookMouseEvent,
} from "uiohook-napi";
import { DEBUG, debug } from "../debug";
import type { OverlayWindow } from "./OverlayWindow";
import type { ServerEvents } from "../server";

// On KDE Wayland, KWin forwards mouse events to the focused Wayland client
// (PoE2) but not to XWayland — so uiohook never sees mousemove while the
// user is hovering the game. We fall back to:
//   - Key-based dismiss: when the held modifier is released, hide the widget.
//     (Keyup events for modifiers DO reach uiohook in our setup.)
//   - Cursor-position polling via screen.getCursorScreenPoint() to detect
//     when the cursor enters the widget area, so we can activate the overlay
//     and make the widget interactive.
const USE_KEY_DISMISS = process.platform === "linux";
const USE_CURSOR_POLL = process.platform === "linux";
const CURSOR_POLL_INTERVAL_MS = 50;

export class WidgetAreaTracker {
  private holdKey!: string;
  private from!: Point;
  private area!: Rectangle;
  private closeThreshold!: number;
  private tracking = false;
  // Logical-coord copy of the area used by the cursor-position polling on
  // Wayland (screen.getCursorScreenPoint returns logical pixels).
  private areaLogical!: Rectangle;
  private cursorPollTimer: NodeJS.Timeout | null = null;
  constructor(
    private server: ServerEvents,
    private overlay: OverlayWindow,
  ) {
    this.server.onEventAnyClient("OVERLAY->MAIN::track-area", (opts) => {
      debug(
        `[AreaTracker] track-area received holdKey=${opts.holdKey} ` +
          `from=${opts.from.x},${opts.from.y} ` +
          `area=${opts.area.x},${opts.area.y}+${opts.area.width}x${opts.area.height}`,
      );
      this.holdKey = opts.holdKey;

      if (process.platform === "win32") {
        this.closeThreshold = opts.closeThreshold * opts.dpr;
        this.from = screen.dipToScreenPoint(opts.from);
        // NOTE: bug in electron accepting only integers
        this.area = screen.dipToScreenRect(null, roundRect(opts.area));
      } else if (process.platform === "linux") {
        this.closeThreshold = opts.closeThreshold * opts.dpr;

        const display = screen.getDisplayNearestPoint(opts.from);
        const scaleX = (value: number) =>
          scaleNumberByDisplay(
            value,
            display.bounds.x,
            display.nativeOrigin.x,
            display.scaleFactor,
          );
        const scaleY = (value: number) =>
          scaleNumberByDisplay(
            value,
            display.bounds.y,
            display.nativeOrigin.y,
            display.scaleFactor,
          );

        // scale coordinates using the display scale factor.
        this.from = {
          x: scaleX(opts.from.x),
          y: scaleY(opts.from.y),
        };

        this.area = roundRect({
          x: scaleX(opts.area.x),
          y: scaleY(opts.area.y),
          width: opts.area.width * display.scaleFactor,
          height: opts.area.height * display.scaleFactor,
        });
      } else {
        this.closeThreshold = opts.closeThreshold;
        this.from = opts.from;
        this.area = opts.area;
      }

      // Store the unscaled (logical) area for cursor polling.
      this.areaLogical = roundRect(opts.area);

      this.removeListeners();
      this.tracking = true;
      uIOhook.addListener("mousemove", this.handleMouseMove);
      uIOhook.addListener("mousedown", this.handleMouseDown);
      if (USE_KEY_DISMISS) {
        uIOhook.addListener("keyup", this.handleKeyUp);
      }
      if (USE_CURSOR_POLL) {
        this.cursorPollTimer = setInterval(
          this.pollCursor,
          CURSOR_POLL_INTERVAL_MS,
        );
      }
      debug(`[AreaTracker] listeners installed`);
    });
  }

  removeListeners() {
    this.tracking = false;
    uIOhook.removeListener("mousemove", this.handleMouseMove);
    uIOhook.removeListener("mousedown", this.handleMouseDown);
    if (USE_KEY_DISMISS) {
      uIOhook.removeListener("keyup", this.handleKeyUp);
    }
    if (this.cursorPollTimer) {
      clearInterval(this.cursorPollTimer);
      this.cursorPollTimer = null;
    }
  }

  // Polled on Wayland because uiohook mousemove doesn't fire while PoE2 has
  // focus (KWin doesn't forward to XWayland). When the cursor enters the
  // widget area, assertOverlayActive() makes the widget interactive — same
  // effect as handleMouseMove's `isPointInsideRect → assertOverlayActive`
  // branch would normally have.
  private pollCount = 0;
  private readonly pollCursor = () => {
    if (!this.tracking) return;
    // Use OverlayWindow's getCursorPoint which on Wayland reads the live
    // KWin-side position via the WaylandTracker DBus feed. screen
    // .getCursorScreenPoint() returns frozen data on Wayland.
    const cursor = this.overlay.getCursorPoint();
    const inside = isPointInsideRect(cursor, this.areaLogical);
    if (DEBUG && this.pollCount++ % 10 === 0) {
      console.log(
        `[AreaTracker] poll #${this.pollCount} cursor=${cursor.x},${cursor.y} ` +
          `areaLogical=${this.areaLogical.x},${this.areaLogical.y}+${this.areaLogical.width}x${this.areaLogical.height} ` +
          `inside=${inside} interactable=${this.overlay.isInteractable}`,
      );
    }
    if (!this.overlay.isInteractable && inside) {
      debug(`[AreaTracker] poll: cursor inside area → activate`);
      this.overlay.assertOverlayActive();
    }
  };

  // Wayland fallback: dismiss the widget when the held modifier is released.
  // Replaces the "release modifier + move cursor outside area" model since
  // uiohook doesn't see mousemove while PoE2 has focus on Wayland.
  private readonly handleKeyUp = (e: UiohookKeyboardEvent) => {
    if (!this.tracking) return;
    if (this.overlay.isInteractable) return;
    const heldModifier = this.holdKey;
    let stillHeld = false;
    if (heldModifier === "Ctrl") stillHeld = e.ctrlKey;
    else if (heldModifier === "Alt") stillHeld = e.altKey;
    else if (heldModifier === "Shift") stillHeld = e.shiftKey;
    if (stillHeld) return;
    debug(`[AreaTracker] keyup-dismiss (${heldModifier} released)`);
    this.server.sendEventTo("broadcast", {
      name: "MAIN->OVERLAY::hide-exclusive-widget",
      payload: undefined,
    });
    this.removeListeners();
  };

  private readonly handleMouseMove = (e: UiohookMouseEvent) => {
    const modifier = e.ctrlKey ? "Ctrl" : e.altKey ? "Alt" : undefined;
    debug(
      `[AreaTracker] move e=${e.x},${e.y} modifier=${modifier} holdKey=${this.holdKey} ` +
        `interactable=${this.overlay.isInteractable} from=${this.from.x},${this.from.y} ` +
        `area=${this.area.x},${this.area.y}+${this.area.width}x${this.area.height} ` +
        `inside=${isPointInsideRect(e, this.area)}`,
    );
    if (!this.overlay.isInteractable && modifier !== this.holdKey) {
      const distance = Math.hypot(e.x - this.from.x, e.y - this.from.y);
      if (distance > this.closeThreshold) {
        debug(`[AreaTracker] HIDE (distance=${distance} > ${this.closeThreshold})`);
        this.server.sendEventTo("broadcast", {
          name: "MAIN->OVERLAY::hide-exclusive-widget",
          payload: undefined,
        });
        this.removeListeners();
      }
    } else if (isPointInsideRect(e, this.area)) {
      debug(`[AreaTracker] inside → assertOverlayActive`);
      this.overlay.assertOverlayActive();
    } else if (this.overlay.isInteractable) {
      debug(`[AreaTracker] interactable + outside → assertGameActive`);
      this.removeListeners();
      this.overlay.assertGameActive();
    }
  };

  private readonly handleMouseDown = (e: UiohookMouseEvent) => {
    if (isPointInsideRect(e, this.area)) {
      this.removeListeners();
      this.overlay.assertOverlayActive();
    }
  };
}

function isPointInsideRect(point: Point, rect: Rectangle) {
  return (
    point.x > rect.x &&
    point.x < rect.x + rect.width &&
    point.y > rect.y &&
    point.y < rect.y + rect.height
  );
}

function roundRect(rect: Rectangle) {
  // NOTE: bug in electron accepting only integers
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}
function scaleNumberByDisplay(
  value: number,
  boundValue: number,
  nativeValue: number,
  scaleFactor: number,
) {
  return (value - boundValue + nativeValue) * scaleFactor;
}
