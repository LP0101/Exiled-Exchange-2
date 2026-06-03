import process from "process";
import { keyTapByName, keyTapWithModsByName } from "./InputSynth";
import type { HostClipboard } from "./HostClipboard";
import type { OverlayWindow } from "../windowing/OverlayWindow";

const PLACEHOLDER_LAST = "@last";
const AUTO_CLEAR = [
  "#", // Global
  "%", // Party
  "@", // Whisper
  "$", // Trade
  "&", // Guild
  "/", // Command
];

// All key synthesis goes through InputSynth — on Wayland uiohook's XTest
// path doesn't reach Wayland clients (PoE2 sees nothing). InputSynth
// routes through ydotool on Linux and falls back to uiohook elsewhere.
export function typeInChat(
  text: string,
  send: boolean,
  clipboard: HostClipboard,
) {
  clipboard.restoreShortly((clipboard) => {
    const modKey = process.platform === "darwin" ? "Meta" : "Ctrl";
    const modifiers = [modKey];

    if (text.startsWith(PLACEHOLDER_LAST)) {
      text = text.slice(`${PLACEHOLDER_LAST} `.length);
      clipboard.writeText(text);
      keyTapWithModsByName("Enter", modifiers);
    } else if (text.endsWith(PLACEHOLDER_LAST)) {
      text = text.slice(0, -PLACEHOLDER_LAST.length);
      clipboard.writeText(text);
      keyTapWithModsByName("Enter", modifiers);
      keyTapByName("Home");
      // press twice to focus input when using controller
      keyTapByName("Home");
      keyTapByName("Delete");
    } else {
      clipboard.writeText(text);
      keyTapByName("Enter");
      if (!AUTO_CLEAR.includes(text[0])) {
        keyTapWithModsByName("A", modifiers);
      }
    }

    keyTapWithModsByName("V", modifiers);

    if (send) {
      keyTapByName("Enter");
      // Upstream's "restore the last chat" tail (Enter, ArrowUp×2,
      // Escape) is a Windows/X11 PoE2 dance that assumes Enter closes
      // chat after sending. On Wayland/Proton PoE2 the chat stays open
      // and the sent text is retained in the input, so each Enter
      // re-sends the same command. Escape then opens the game menu
      // (because chat is no longer the focused widget by that point).
      // Skip the whole tail on Linux — Enter alone sends and the game
      // closes chat naturally.
      if (process.platform !== "linux") {
        keyTapByName("Enter");
        keyTapByName("ArrowUp");
        keyTapByName("ArrowUp");
        keyTapByName("Escape");
      }
    }
  });
}

export function stashSearch(
  text: string,
  clipboard: HostClipboard,
  overlay: OverlayWindow,
) {
  clipboard.restoreShortly((clipboard) => {
    overlay.assertGameActive();
    clipboard.writeText(text);
    keyTapWithModsByName("F", ["Ctrl"]);

    keyTapWithModsByName(
      "V",
      [process.platform === "darwin" ? "Meta" : "Ctrl"],
    );
    keyTapByName("Enter");
  });
}
