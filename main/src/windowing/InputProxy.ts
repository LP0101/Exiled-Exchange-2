import { BrowserWindow } from "electron";
import { debug } from "../debug";

// A tiny, invisible, focusable BrowserWindow whose only job is to attract
// Wayland keyboard focus away from PoE2 when an EE2 panel is up, then
// forward each keystroke into the main overlay window.
//
// Why it exists: on KDE Wayland the main overlay BrowserWindow has to be
// constructed focusable:false so KWin will composite it above PoE2's
// fullscreen Wayland surface (focusable:true demotes us to a peer app
// and fullscreen PoE2 stacks above). focusable:false means KWin never
// routes keyboard input to us. Splitting the concerns into two windows
// keeps both working: main stays visible-and-deaf, proxy stays
// focusable-and-invisible.
//
// Forwarding model: every keyDown and keyUp the proxy receives is
// replayed as a synthetic KeyboardEvent on the main overlay's
// document.activeElement via executeJavaScript. For keyDown that's not
// preventDefault'd (i.e. the focused element doesn't have its own
// handler claiming the key — see HotkeyInput.vue which does), we ALSO
// mutate the element's value: insert printable chars, run
// Backspace/Delete/Arrow/Home/End on inputs that support the selection
// API, fall back to direct value manipulation on inputs that don't
// (type=number, etc.). v-model picks up the change because we dispatch
// an 'input' event after mutation.
//
// Why not webContents.sendInputEvent: it requires the target
// BrowserWindow be focused, which our focusable:false main never is.
// Why not webContents.insertText alone: it bypasses keydown handlers
// entirely, which breaks components like HotkeyInput that need to see
// the keyup with modifier state to capture hotkey bindings.
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
      event.preventDefault();
      // Electron's before-input-event docs claim it fires for both
      // keyDown and keyUp, but under our invisible focusable proxy on
      // KDE Wayland it only fires for keyDown. To keep handlers like
      // HotkeyInput.vue (which listens on @keyup) working, we dispatch
      // BOTH keydown and keyup synthetic events on each Electron
      // keyDown. The synthetic pair is back-to-back rather than
      // separated by hold-time, which only matters if a listener
      // distinguishes "currently held" from "released" — none of our
      // current renderer listeners do.
      if (input.type !== "keyDown") return;

      if (input.key === "Escape") {
        debug("[InputProxy] Escape → dismiss");
        this.onEscape();
        return;
      }

      this.dispatchToTarget(input, "keydown");
      this.dispatchToTarget(input, "keyup");
      debug(
        `[InputProxy] keyDown→{keydown,keyup} key=${input.key} code=${input.code} ctrl=${input.control} shift=${input.shift} alt=${input.alt}`,
      );
    });
  }

  private dispatchToTarget(input: Electron.Input, evtType: "keydown" | "keyup"): void {
    // Build the IIFE that runs in the renderer. Dispatches a synthetic
    // KeyboardEvent with the proper code/key/modifier props so handlers
    // like HotkeyInput's @keyup can see the same data they'd see for a
    // real keypress. For keydown, if no listener preventDefault'd it,
    // ALSO mutate the focused element's value to mirror the browser's
    // default text-input behavior (insert/delete/move/etc).
    const js = `
      (function() {
        const el = document.activeElement;
        if (!el) return;
        const evtInit = {
          key: ${JSON.stringify(input.key)},
          code: ${JSON.stringify(input.code)},
          ctrlKey: ${input.control},
          shiftKey: ${input.shift},
          altKey: ${input.alt},
          metaKey: ${input.meta},
          bubbles: true,
          cancelable: true,
        };
        const allowDefault = el.dispatchEvent(new KeyboardEvent(${JSON.stringify(evtType)}, evtInit));
        if (${evtType === "keydown" ? "true" : "false"} && allowDefault) {
          const isText = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
          if (!isText) return;
          const key = evtInit.key;
          const fireInput = () => el.dispatchEvent(new Event('input', { bubbles: true }));
          let hasSelection = true;
          try {
            if (el.selectionStart === null) hasSelection = false;
          } catch (e) { hasSelection = false; }
          if (hasSelection) {
            const start = el.selectionStart;
            const end = el.selectionEnd;
            const isPrintable = key.length === 1 && !evtInit.ctrlKey && !evtInit.altKey && !evtInit.metaKey;
            if (isPrintable) {
              el.setRangeText(key, start, end, 'end');
              fireInput();
            } else if (key === 'Backspace') {
              if (start !== end) el.setRangeText('', start, end, 'end');
              else if (start > 0) el.setRangeText('', start - 1, start, 'end');
              fireInput();
            } else if (key === 'Delete') {
              if (start !== end) el.setRangeText('', start, end, 'end');
              else if (start < el.value.length) el.setRangeText('', start, start + 1, 'end');
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
            } else if (key === 'Enter' && el.tagName === 'TEXTAREA') {
              el.setRangeText('\\n', start, end, 'end');
              fireInput();
            }
          } else {
            // Inputs without selection API (type=number, etc.). For
            // printable chars we use document.execCommand which IS
            // selection-aware (it replaces highlighted text correctly
            // even on number inputs where selectionStart throws).
            // Deprecated API, but Chromium still implements it and
            // there's no modern replacement that handles inputs.
            const isPrintable = key.length === 1 && !evtInit.ctrlKey && !evtInit.altKey && !evtInit.metaKey;
            if (isPrintable) {
              let ok = false;
              try { ok = document.execCommand('insertText', false, key); } catch (e) {}
              if (!ok) {
                el.value = String(el.value) + key;
              }
              fireInput();
            } else if (key === 'Backspace') {
              let ok = false;
              try { ok = document.execCommand('delete'); } catch (e) {}
              if (!ok) {
                el.value = String(el.value).slice(0, -1);
              }
              fireInput();
            } else if (el.type === 'number' && (key === 'ArrowUp' || key === 'ArrowDown')) {
              const step = parseFloat(el.step) || 1;
              const cur = parseFloat(el.value) || 0;
              const next = key === 'ArrowUp' ? cur + step : cur - step;
              const min = el.min !== '' ? parseFloat(el.min) : -Infinity;
              const max = el.max !== '' ? parseFloat(el.max) : Infinity;
              el.value = String(Math.min(max, Math.max(min, next)));
              fireInput();
            }
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
