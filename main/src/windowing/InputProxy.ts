import { BrowserWindow } from "electron";
import { debug } from "../debug";

// A tiny, invisible, focusable BrowserWindow whose only job is to attract
// Wayland keyboard focus away from PoE2 when the user is interacting with
// an EE2 panel, then forward each keystroke into the main overlay window
// via webContents.sendInputEvent.
//
// Why it exists: on KDE Wayland the main overlay BrowserWindow has to be
// constructed focusable:false so KWin will composite it above PoE2's
// fullscreen Wayland surface (focusable:true demotes us to a peer app and
// fullscreen PoE2 stacks above). focusable:false means KWin never routes
// keyboard input to us, so text inputs in the panel can't receive
// keystrokes. Splitting the concerns into two windows keeps visibility
// and keyboard input both working: main stays visible-and-deaf, proxy
// stays focusable-and-invisible.
//
// Forwarding: before-input-event fires for every key event before any
// renderer-side JS sees it. We synthesize the same event on the main
// window via sendInputEvent, which dispatches it through to the
// document and lands on document.activeElement (the input element the
// user clicked into).
export class InputProxy {
  private window: BrowserWindow;
  private shown = false;

  constructor(
    private target: BrowserWindow,
    private onEscape: () => void,
  ) {
    this.window = new BrowserWindow({
      focusable: true,
      frame: false,
      transparent: true,
      show: false,
      skipTaskbar: true,
      hasShadow: false,
      width: 1,
      height: 1,
      x: 0,
      y: 0,
      alwaysOnTop: true,
      resizable: false,
      movable: false,
      webPreferences: {
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    // Empty page is fine — we never render anything, we just need a
    // webContents so before-input-event has somewhere to fire.
    this.window.loadURL("data:text/html,<html><body></body></html>");

    this.window.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") {
        event.preventDefault();
        return;
      }

      // sendInputEvent requires the BrowserWindow be focused, which our
      // target (focusable:false main overlay) never is — so it silently
      // drops events. insertText doesn't have that restriction; it routes
      // straight to the focused DOM element regardless of OS-level window
      // focus.
      //
      // First pass: only printable chars (letters/digits/symbols, no
      // Ctrl/Alt combos). input.key is the character produced (already
      // accounts for Shift). Anything else (Backspace, Enter, arrows,
      // modifier combos) we ignore for now — needs a renderer-side IPC
      // handler that synthesizes the right effect on activeElement.
      const isPrintable =
        input.key.length === 1 && !input.control && !input.alt && !input.meta;

      if (isPrintable) {
        this.target.webContents.insertText(input.key);
        debug(`[InputProxy] insertText ${JSON.stringify(input.key)}`);
      } else if (input.key === "Escape") {
        debug(`[InputProxy] Escape → dismiss`);
        this.onEscape();
      } else {
        // Special keys (Backspace, Delete, Enter, arrows, Home, End):
        // synthesize on document.activeElement via injected JS. Vue's
        // v-model listens for the 'input' event, so dispatching it after
        // mutating .value propagates the change to bound state.
        this.synthSpecialKey(input.key);
        debug(`[InputProxy] synth special key=${input.key}`);
      }

      // Don't let our proxy's renderer process the event (it's an empty
      // page anyway, but avoid edge cases like Ctrl+R reloading).
      event.preventDefault();
    });
  }

  private synthSpecialKey(key: string): void {
    // setRangeText / selectionStart aren't supported on <input type="number">,
    // <input type="email">, etc. — they throw InvalidStateError. We detect
    // these and fall back to manipulating el.value as a plain string.
    const js = `
      (function() {
        const el = document.activeElement;
        if (!el) return;
        const isText = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
        if (!isText) return;
        const key = ${JSON.stringify(key)};
        const fireInput = () => el.dispatchEvent(new Event('input', { bubbles: true }));
        let hasSelection = true;
        let selStart = null;
        try {
          selStart = el.selectionStart;
          if (selStart === null) hasSelection = false;
        } catch (e) { hasSelection = false; }
        if (!hasSelection) {
          // Fallback path for inputs that reject the selection API
          // (type=number, type=email, etc.). We can't know the cursor
          // position, so Backspace deletes the trailing char and Delete
          // is a no-op (the previous "treat as Backspace" was misleading
          // when the user expected forward-delete).
          if (key === 'Backspace') {
            el.value = String(el.value).slice(0, -1);
            fireInput();
          } else if (key === 'Enter') {
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          } else if (el.type === 'number' && (key === 'ArrowUp' || key === 'ArrowDown')) {
            // Native browser behavior for ArrowUp/Down on number inputs
            // increments/decrements by step. Replicate it ourselves since
            // synthetic key events don't trigger the native action.
            const step = parseFloat(el.step) || 1;
            const cur = parseFloat(el.value) || 0;
            const next = key === 'ArrowUp' ? cur + step : cur - step;
            const min = el.min !== '' ? parseFloat(el.min) : -Infinity;
            const max = el.max !== '' ? parseFloat(el.max) : Infinity;
            el.value = String(Math.min(max, Math.max(min, next)));
            fireInput();
          }
          // ArrowLeft/Right, Delete, Home, End: no-op on these inputs.
          return;
        }
        const start = el.selectionStart;
        const end = el.selectionEnd;
        if (key === 'Backspace') {
          if (start !== end) {
            el.setRangeText('', start, end, 'end');
          } else if (start > 0) {
            el.setRangeText('', start - 1, start, 'end');
          }
          fireInput();
        } else if (key === 'Delete') {
          if (start !== end) {
            el.setRangeText('', start, end, 'end');
          } else if (start < el.value.length) {
            el.setRangeText('', start, start + 1, 'end');
          }
          fireInput();
        } else if (key === 'ArrowLeft') {
          const p = Math.max(0, start - 1);
          el.setSelectionRange(p, p);
        } else if (key === 'ArrowRight') {
          const p = Math.min(el.value.length, start + 1);
          el.setSelectionRange(p, p);
        } else if (key === 'Home') {
          el.setSelectionRange(0, 0);
        } else if (key === 'End') {
          el.setSelectionRange(el.value.length, el.value.length);
        } else if (key === 'Enter') {
          if (el.tagName === 'TEXTAREA') {
            el.setRangeText('\\n', start, end, 'end');
            fireInput();
          } else {
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          }
        }
      })();
    `;
    this.target.webContents.executeJavaScript(js, true).catch(() => {});
  }

  show(): void {
    if (this.shown) {
      this.window.focus();
      return;
    }
    this.shown = true;
    debug("[InputProxy] show + focus");
    this.window.show();
    this.window.focus();
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    debug("[InputProxy] hide");
    this.window.hide();
  }

  destroy(): void {
    if (!this.window.isDestroyed()) {
      this.window.destroy();
    }
  }
}
