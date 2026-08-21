import { Game, Utility, printConsole, createText, setTextSize } from "skyrimPlatform";
import { getScreenResolution } from "../../view/formView";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { Mod } from "../messages_http/serverManifest";
import { logTrace } from "../../logging";
import { SettingsService } from "./settingsService";

const STATE_KEY = 'loadOrderCheckState';

/**
 * Mods a player has to install themselves, with somewhere to get them.
 *
 * Kept here rather than fetched, because it ships inside the ordinary client
 * update and changes about as often as the client does. Keys are lowercased
 * filenames, since Skyrim 1.6 is inconsistent about case.
 */
const REQUIRED_MOD_HELP: Record<string, { name: string; url: string }> = {
  "lvxmagick - skyrim - settlement builder.esm": {
    name: "Skyrim Settlement Builder",
    url: "https://www.nexusmods.com/skyrimspecialedition/mods/58021",
  },
};

function describeMod(filename: string): string {
  const help = REQUIRED_MOD_HELP[filename.toLowerCase()];
  return help ? help.name + "\n  " + help.url : filename;
}

interface State {
  statusTextId?: number;
};

export class LoadOrderVerificationService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.once("update", () => this.onceUpdate());
  }

  private onceUpdate() {
    // Wrapped, because this used to be able to throw and take the whole check
    // with it. Neither a working machine nor a broken one printed the load
    // order it is supposed to print, which is how a client running two more
    // plugins than the server reached the world and hung there instead of
    // being told.
    try {
      const result = this.verifyLoadOrder();
      if (result && typeof result.catch === "function") {
        result.catch((e: unknown) => {
          logTrace(this, `load order check failed:`, e);
        });
      }
    } catch (e) {
      logTrace(this, `load order check threw before it could run:`, e);
    }
  }

  private verifyLoadOrder() {
    const settingsService = this.controller.lookupListener(SettingsService);

    this.resetText();
    const clientMods = this.getClientMods();
    this.printModOrder('Client load order:', clientMods);
    return settingsService.getServerMods()
      .then((serverMods) => {
        this.printModOrder('Server load order:', serverMods);
        // Named rather than counted. "Server has 6, we have 5" tells a player
        // nothing they can act on, and this is the case every new joiner hits
        // before they have installed anything.
        const clientNames = new Set(clientMods.map((m) => m.filename.toLowerCase()));
        const absent = serverMods
          .map((m) => m.filename)
          .filter((f) => !clientNames.has(f.toLowerCase()));
        if (absent.length > 0) {
          this.updateText(
            "HEARTHHELD NEEDS A MOD YOU DO NOT HAVE\n\n" +
            absent.map(describeMod).join("\n\n") +
            "\n\nInstall it, then start the launcher again.",
            [255, 190, 90, 1],
          );
          throw new Error("Missing required mods: " + JSON.stringify(absent));
        }
        if (clientMods.length < serverMods.length) {
          throw new Error(`Missing some server mods. Server has ${serverMods.length}, we have ${clientMods.length}`);
        }
        if (clientMods.length > serverMods.length) {
          this.updateText(
            'LOAD ORDER WARNING: you have more mods than server!\n(or could not receive server mod list)\nCheck console for details.',
            [255, 255, 0, 1], 5,
          );
        }
        let fail = [];
        for (let i = 0; i < serverMods.length; ++i) {
          // Need case-insensitive check for 1.6+
          if (
            clientMods[i].filename.toLowerCase() !== serverMods[i].filename.toLowerCase() ||
            clientMods[i].size !== serverMods[i].size ||
            clientMods[i].crc32 !== serverMods[i].crc32
          ) {
            fail.push(i);
            printConsole(`${i}-th mod (numbered from 0) does not match.`);
            printConsole(`Server has ${JSON.stringify(serverMods[i])}`);
            printConsole(`We have ${JSON.stringify(clientMods[i])}`);
          }
        }
        if (fail.length !== 0) {
          // Having the file but not matching byte for byte nearly always means
          // a different version, which needs a different fix from installing
          // it, so it gets its own wording.
          const wrong = fail.map((i) => serverMods[i].filename);
          this.updateText(
            "WRONG VERSION OF A REQUIRED MOD\n\n" +
            wrong.map(describeMod).join("\n\n") +
            "\n\nYou have this mod, but not the same build as the server.\n" +
            "Reinstall it from the link above.",
            [255, 190, 90, 1],
          );

          throw new Error('Load order check failed! Indices: ' + JSON.stringify(fail));
        }
      })
      .catch((err) => {
        printConsole(err);
        if (this.sp.settings['skymp5-client']['ignoreLoadOrderMismatch']) {
          this.updateText(
            'LOAD ORDER ERROR!\nHowever, ignoring it because of ignoreLoadOrderMismatch being set.' +
            '\nExpect EVERYTHING BREAK, unless you know what you are doing.\nCheck console for details.' +
            '\nThis message will disappear after 30 seconds.',
            [255, 0, 0, 1], 30,
          );
          return;
        }
        // Only unexplained failures reach this. Anything we could name has
        // already put a better message on screen, and replacing it with "check
        // the console" would throw away the one useful thing the player was
        // told.
        if (!this.explained) {
          this.updateText(
            'LOAD ORDER ERROR!\nCheck console for details.',
            [255, 0, 0, 1],
          );
        }
      });
  };

  private getState(): State {
    if (typeof this.sp.storage[STATE_KEY] !== 'object') {
      return {};
    }
    return this.sp.storage[STATE_KEY] as State;
  };

  private setState(replacement: State) {
    const oldState = this.sp.storage[STATE_KEY] = this.getState();
    for (const [k, v] of Object.entries(replacement)) {
      (oldState as Record<string, any>)[k] = v;
    }
  };

  private resetText() {
    let { statusTextId } = this.getState();
    if (statusTextId) {
      this.sp.destroyText(statusTextId);
      statusTextId = undefined;
      this.setState({ statusTextId });
    }
  };

  /**
   * Set once something specific is on screen, so the generic "check the
   * console" message does not replace it.
   */
  private explained = false;

  private updateText(text: string, color: [number, number, number, number], clearDelay?: number) {
    if (!clearDelay) {
      this.explained = true;
    }
    const { width, height } = getScreenResolution();
    this.resetText();
    const statusTextId = createText(width / 2, height / 2, text, color);
    setTextSize(statusTextId, 0.5);
    this.setState({ statusTextId });
    if (clearDelay) {
      Utility.wait(clearDelay).then(() => this.resetText());
    }
  }

  private enumerateClientMods(getCount: (() => number), getAt: ((idx: number) => string)) {
    const result = [];
    for (let i = 0; i < getCount(); ++i) {
      const filename = getAt(i);
      const { crc32, size } = this.getFileInfoSafe(filename);
      result.push({ filename, crc32, size });
    }
    return result;
  }

  private getClientMods() {
    return this.enumerateClientMods(Game.getModCount, Game.getModName);
  };

  private printModOrder(header: string, order: Mod[]) {
    printConsole(header);
    for (const [i, mod] of Object.entries(order)) {
      printConsole(`#${i} ${JSON.stringify(mod)}`);
    }
  };

  private getFileInfoSafe(filename: string) {
    try {
      return this.sp.getFileInfo(filename);
    } catch (e) {
      const message = (e as Record<string, unknown>).message;

      if (typeof message === "string" && message.includes('is not a valid argument')) {
        logTrace(this, `Failed to get file info for`, filename);
        return { crc32: 0, size: 0 };
      } else {
        throw e;
      }
    }
  }
}
