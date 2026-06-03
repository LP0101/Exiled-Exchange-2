import { spawn } from "child_process";
import { uIOhook, UiohookKey } from "uiohook-napi";
import { debug } from "../debug";
import { isKdeWayland } from "../windowing/WaylandTracker";

const WAYLAND = isKdeWayland();

// Linux input event codes (from /usr/include/linux/input-event-codes.h).
// Names match the strings used in the app's shortcut format (Ctrl, Shift, A,
// F1, ArrowRight, etc.) so we can take the same string identifiers the rest
// of the code already produces.
const NAME_TO_EVDEV: Record<string, number> = {
  Ctrl: 29,
  Shift: 42,
  Alt: 56,
  A: 30, B: 48, C: 46, D: 32, E: 18, F: 33, G: 34, H: 35, I: 23,
  J: 36, K: 37, L: 38, M: 50, N: 49, O: 24, P: 25, Q: 16, R: 19,
  S: 31, T: 20, U: 22, V: 47, W: 17, X: 45, Y: 21, Z: 44,
  "0": 11, "1": 2, "2": 3, "3": 4, "4": 5,
  "5": 6, "6": 7, "7": 8, "8": 9, "9": 10,
  Space: 57, Enter: 28, Escape: 1, Backspace: 14, Tab: 15,
  ArrowLeft: 105, ArrowRight: 106, ArrowUp: 103, ArrowDown: 108,
  Home: 102, End: 107, Delete: 111, Insert: 110,
  PageUp: 104, PageDown: 109,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64,
  F7: 65, F8: 66, F9: 67, F10: 68, F11: 87, F12: 88,
  Meta: 125,
};

export interface KeyEvent {
  name: string;
  state: "down" | "up";
}

function uiohookKey(name: string): number | undefined {
  return (UiohookKey as unknown as Record<string, number>)[name];
}

function spawnYdotool(args: string[]) {
  debug(`[InputSynth] ydotool ${args.join(" ")}`);
  try {
    const child = spawn("ydotool", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        console.error(
          `[InputSynth] ydotool exited ${code}, stderr=${stderr.trim()}`,
        );
      }
    });
    child.on("error", (err) => {
      console.error(`[InputSynth] ydotool spawn error: ${err.message}`);
    });
  } catch (err) {
    console.error(
      `[InputSynth] failed to launch ydotool: ${(err as Error).message}`,
    );
  }
}

// Batch all synthesis calls made within a single JS tick into one ydotool
// invocation. Two reasons:
//   - Ordering: two concurrent `ydotool` processes can race on the ydotoold
//     socket; their events may arrive out of order. A single invocation
//     submits a strictly-ordered sequence.
//   - Atomicity: PoE2 only treats "Ctrl+Alt+C" as a copy when the modifiers
//     and C arrive as a clean combo. Splitting them across processes lets
//     other state (a still-held hotkey, etc.) get interleaved.
const waylandQueue: KeyEvent[] = [];
let flushScheduled = false;

// PoE2 needs ~30ms between synthesized events to register each one cleanly;
// ydotool's default (12ms) is too tight and the game silently drops the combo.
const YDOTOOL_KEY_DELAY_MS = 30;

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  process.nextTick(() => {
    flushScheduled = false;
    if (waylandQueue.length === 0) return;
    const tokens: string[] = [
      "key",
      "--key-delay",
      String(YDOTOOL_KEY_DELAY_MS),
    ];
    for (const ev of waylandQueue) {
      const code = NAME_TO_EVDEV[ev.name];
      if (code === undefined) continue;
      tokens.push(`${code}:${ev.state === "down" ? 1 : 0}`);
    }
    waylandQueue.length = 0;
    if (tokens.length > 3) spawnYdotool(tokens);
  });
}

function queueWayland(events: KeyEvent[]) {
  for (const ev of events) {
    if (NAME_TO_EVDEV[ev.name] !== undefined) waylandQueue.push(ev);
  }
  scheduleFlush();
}

export function keyToggleByName(name: string, direction: "down" | "up"): void {
  if (WAYLAND) {
    queueWayland([{ name, state: direction }]);
    return;
  }
  const k = uiohookKey(name);
  if (k !== undefined) uIOhook.keyToggle(k, direction);
}

export function keyTapByName(name: string): void {
  if (WAYLAND) {
    queueWayland([
      { name, state: "down" },
      { name, state: "up" },
    ]);
    return;
  }
  const k = uiohookKey(name);
  if (k !== undefined) uIOhook.keyTap(k);
}

// Tap a key while a set of modifiers is held. On Wayland, expands into an
// ordered sequence (mods down → key down/up → mods up reverse) and pushes
// it through the ydotool batching queue. On other backends, passes through
// to uIOhook.keyTap(key, [mod1, mod2, ...]).
export function keyTapWithModsByName(name: string, mods: string[]): void {
  if (WAYLAND) {
    const events: KeyEvent[] = [];
    for (const m of mods) events.push({ name: m, state: "down" });
    events.push({ name, state: "down" });
    events.push({ name, state: "up" });
    for (const m of [...mods].reverse()) events.push({ name: m, state: "up" });
    queueWayland(events);
    return;
  }
  const modCodes: number[] = [];
  for (const m of mods) {
    const c = uiohookKey(m);
    if (c !== undefined) modCodes.push(c);
  }
  const k = uiohookKey(name);
  if (k !== undefined) uIOhook.keyTap(k, modCodes);
}

export function keySequenceByName(events: KeyEvent[]): void {
  if (WAYLAND) {
    queueWayland(events);
    return;
  }
  for (const ev of events) {
    const k = uiohookKey(ev.name);
    if (k !== undefined) uIOhook.keyToggle(k, ev.state);
  }
}
