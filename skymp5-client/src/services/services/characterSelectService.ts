import { ClientListener, CombinedController, Sp } from "./clientListener";
import { BrowserMessageEvent } from "skyrimPlatform";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { MsgType } from "../../messages";
import { AuthService } from "./authService";
import { logError, logTrace } from "../../logging";

const BROWSER_EVENT_KEY = "hhCharacterSelect";
const PACKET_SHOW = "hhCharacterSelect";
const PACKET_ACTION = "hhCharacterSelectAction";

interface SlotInfo {
  formId: number;
  name: string;
}

/**
 * The character screen shown BEFORE the player enters the world.
 *
 * The gamemode's own character screen rides on an actor property, which is no
 * use here: the whole point is that no actor has been assigned yet, so the
 * server holds the player at login and sends the roster over a custom packet
 * instead. Selecting one tells the server to finish the spawn.
 *
 * Existing before spawn is what makes deletion safe. Deleting from the in-game
 * screen means deleting the character you are currently playing, mid-session;
 * here you are playing nothing yet, so there is nothing to leave behind.
 *
 * Also tells AuthService to hold off its 15 second "never saw gameplay"
 * timeout, which would otherwise disconnect the player while they are still
 * choosing.
 */
export class CharacterSelectService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    let content: Record<string, unknown>;
    try {
      content = JSON.parse(event.message.contentJsonDump);
    } catch (e) {
      return;
    }
    if (content["customPacketType"] !== PACKET_SHOW) {
      return;
    }

    const slots = (content["slots"] as SlotInfo[]) ?? [];
    const maxSlots = (content["maxSlots"] as number) ?? 2;

    this.controller.lookupListener(AuthService).setSpawnDeferred(true);
    logTrace(this, `Showing pre-spawn character screen with ${slots.length} character(s)`);

    this.sp.browser.setVisible(true);
    this.sp.browser.setFocused(true);
    this.sp.browser.executeJavaScript(this.buildWidgetJs(slots, maxSlots));
  }

  private buildWidgetJs(slots: SlotInfo[], maxSlots: number): string {
    const data = JSON.stringify({ slots, maxSlots, key: BROWSER_EVENT_KEY });
    // Built as a string for the browser context: this file runs in the game
    // process, where there is no window and no widgets API.
    return `(function (data) {
      var send = function (action) {
        return function () { window.skyrimPlatform.sendMessage(data.key, action); };
      };
      window.hhWidgets = window.hhWidgets || {};
      window.hhApplyWidgets = window.hhApplyWidgets || function () {
        var list = [];
        if (window.hhWidgets.chat) { list.push(window.hhWidgets.chat); }
        if (window.hhWidgets.form) { list.push(window.hhWidgets.form); }
        window.skyrimPlatform.widgets.set(list);
      };
      window.hhRenderPreSpawn = function () {
        var heading = data.slots.length === 0 ? 'No characters yet' : 'Choose a character';
        var elements = [{ type: 'text', text: heading, tags: [] }];
        data.slots.forEach(function (slot) {
          elements.push({
            type: 'button', text: slot.name,
            tags: ['BUTTON_STYLE_FRAME', 'ELEMENT_STYLE_MARGIN_EXTENDED'],
            click: send('play:' + slot.formId), hint: 'Enter the world as this character'
          });
          if (window.hhConfirmDelete === slot.formId) {
            elements.push({ type: 'text', text: 'Delete ' + slot.name + ' forever?', tags: [] });
            elements.push({ type: 'button', text: 'Yes, delete ' + slot.name, tags: [],
              click: send('delete:' + slot.formId), hint: 'This cannot be undone' });
            elements.push({ type: 'button', text: 'Cancel', tags: [],
              click: function () { window.hhConfirmDelete = null; window.hhRenderPreSpawn(); },
              hint: 'Keep this character' });
          } else {
            elements.push({ type: 'button', text: 'Delete ' + slot.name, tags: [],
              click: function () { window.hhConfirmDelete = slot.formId; window.hhRenderPreSpawn(); },
              hint: 'Permanently delete this character' });
          }
        });
        if (data.slots.length < data.maxSlots) {
          elements.push({
            type: 'button', text: 'Create a new character',
            tags: ['BUTTON_STYLE_FRAME', 'ELEMENT_STYLE_MARGIN_EXTENDED'],
            click: send('new'), hint: 'Use a free slot'
          });
        }
        window.hhWidgets.form = { type: 'form', id: 4, caption: 'Characters', elements: elements };
        window.hhApplyWidgets();
      };
      window.hhConfirmDelete = null;
      window.hhRenderPreSpawn();
    })(${data})`;
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    if (e.arguments[0] !== BROWSER_EVENT_KEY) {
      return;
    }
    const action = String(e.arguments[1] ?? "");
    if (!action) {
      return;
    }

    // Deleting keeps the screen up, since the player still has to choose.
    // Anything else means they are on their way into the world.
    const entering = !action.startsWith("delete:");
    if (entering) {
      this.sp.browser.executeJavaScript(
        "window.hhWidgets = window.hhWidgets || {}; window.hhWidgets.form = null;" +
          "if (window.hhApplyWidgets) { window.hhApplyWidgets(); }",
      );
      this.sp.browser.setFocused(false);
      this.controller.lookupListener(AuthService).setSpawnDeferred(false);
    }

    const message: CustomPacketMessage = {
      t: MsgType.CustomPacket,
      contentJsonDump: JSON.stringify({ customPacketType: PACKET_ACTION, action }),
    };
    try {
      this.controller.emitter.emit("sendMessage", { message, reliability: "reliable" });
    } catch (err) {
      logError(this, `Failed to send character selection`, err);
    }
  }
}
