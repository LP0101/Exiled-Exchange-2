import { spawnSync } from "child_process";
import { clipboard, Clipboard } from "electron";
import { debug } from "../debug";
import type { Logger } from "../RemoteLogger";
import { isKdeWayland } from "../windowing/WaylandTracker";

const POLL_DELAY = 48;
const POLL_LIMIT = 1500;

// Under native KDE Wayland the overlay process is XWayland; PoE2 is native
// Wayland. Electron's clipboard.readText() reads the X11 CLIPBOARD, but
// XWayland only lazily mirrors the Wayland selection into it (usually on a
// focus change), so polling sees nothing during the action. Shell out to
// wl-paste to read the Wayland selection directly.
const USE_WL_PASTE = isKdeWayland();

function readClipboardText(): string {
  if (USE_WL_PASTE) {
    const result = spawnSync("wl-paste", ["--no-newline"], {
      encoding: "utf-8",
      timeout: 100,
    });
    if (result.status === 0 && typeof result.stdout === "string") {
      return result.stdout;
    }
    return "";
  }
  return clipboard.readText();
}

function writeClipboardText(text: string): void {
  if (USE_WL_PASTE) {
    spawnSync("wl-copy", [text], { timeout: 100 });
    return;
  }
  clipboard.writeText(text);
}

// PoE must read clipboard within this timeframe,
// after that we restore clipboard.
// If game lagged for some reason, it will read
// wrong content (= restored clipboard, potentially containing password).
const RESTORE_AFTER = 120;

export class HostClipboard {
  private pollPromise?: Promise<string>;
  private elapsed = 0;
  private shouldRestore = false;

  private isRestored = true;

  get isPolling() {
    return this.pollPromise != null;
  }

  constructor(private logger: Logger) {}

  updateOptions(restoreClipboard: boolean) {
    this.shouldRestore = restoreClipboard;
  }

  async readItemText(): Promise<string> {
    this.elapsed = 0;
    if (this.pollPromise) {
      return await this.pollPromise;
    }

    let textBefore = readClipboardText();
    if (isPoeItem(textBefore)) {
      textBefore = "";
      writeClipboardText("");
    }

    this.pollPromise = new Promise((resolve, reject) => {
      const poll = () => {
        const textAfter = readClipboardText();
        debug(
          `[ClipboardPoller] t=${this.elapsed}ms len=${textAfter.length} first40="${textAfter.slice(0, 40).replace(/\n/g, "\\n")}" isPoeItem=${!!isPoeItem(textAfter)}`,
        );

        if (isPoeItem(textAfter)) {
          if (this.shouldRestore) {
            writeClipboardText(textBefore);
          }
          this.pollPromise = undefined;
          resolve(textAfter);
        } else {
          this.elapsed += POLL_DELAY;
          if (this.elapsed < POLL_LIMIT) {
            setTimeout(poll, POLL_DELAY);
          } else {
            if (this.shouldRestore) {
              writeClipboardText(textBefore);
            }
            this.pollPromise = undefined;

            if (!isPoeItem(textAfter)) {
              this.logger.write("warn [ClipboardPoller] No item text found.");
            }
            reject(new Error("Reading clipboard timed out"));
          }
        }
      };
      setTimeout(poll, POLL_DELAY);
    });

    return await this.pollPromise;
  }

  // when `shouldRestore` is false, this function continues
  // to work as a throttler for callback
  restoreShortly(cb: (clipboard: Clipboard) => void) {
    // Not only do we not overwrite the clipboard, but we don't exec callback.
    // This throttling helps against disconnects from "Too many actions".
    if (!this.isRestored) {
      return;
    }

    this.isRestored = false;
    const saved = readClipboardText();
    cb(clipboard);
    setTimeout(() => {
      if (this.shouldRestore) {
        writeClipboardText(saved);
      }
      this.isRestored = true;
    }, RESTORE_AFTER);
  }
}

function isPoeItem(text: string) {
  return LANGUAGE_DETECTOR.find(({ firstLine }) => text.startsWith(firstLine));
}

const LANGUAGE_DETECTOR = [
  {
    lang: "en",
    firstLine: "Item Class: ",
  },
  {
    lang: "ru",
    firstLine: "Класс предмета: ",
  },
  {
    lang: "fr",
    firstLine: "Classe d'objet: ",
  },
  {
    lang: "de",
    firstLine: "Gegenstandsklasse: ",
  },
  {
    lang: "pt",
    firstLine: "Classe do Item: ",
  },
  {
    lang: "es",
    firstLine: "Clase de objeto: ",
  },
  {
    lang: "th",
    firstLine: "ชนิดไอเทม: ",
  },
  {
    lang: "ko",
    firstLine: "아이템 종류: ",
  },
  {
    lang: "cmn-Hant",
    firstLine: "物品種類: ",
  },
  {
    lang: "cmn-Hans",
    firstLine: "物品类别: ",
  },
  {
    lang: "ja",
    firstLine: "アイテムクラス: ",
  },
];
