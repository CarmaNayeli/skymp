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
    // Deleting belongs to sitting down to play, not to scrambling back in
    // after a crash. Which of those this is can only be answered here: it is a
    // property of this copy of Skyrim, not of the server, which has no idea
    // whether the game was just started. storage survives a reconnection and
    // dies with the process, so a count of zero means nothing has been loaded
    // yet, which is only true on a fresh launch.
    const loadsSoFar = Number((this.sp.storage as Record<string, unknown>)["hhGameLoads"]) || 0;
    const canDelete = content["canDelete"] === true && loadsSoFar === 0;

    this.controller.lookupListener(AuthService).setSpawnDeferred(true);
    logTrace(this, `Showing pre-spawn character screen with ${slots.length} character(s)`);

    this.sp.browser.setVisible(true);
    this.sp.browser.setFocused(true);
    this.sp.browser.executeJavaScript(this.buildWidgetJs(slots, maxSlots, canDelete));
  }

  private buildWidgetJs(slots: SlotInfo[], maxSlots: number, canDelete: boolean): string {
    const data = JSON.stringify({ slots, maxSlots, canDelete, key: BROWSER_EVENT_KEY });
    // Built as a string for the browser context: this file runs in the game
    // process, where there is no window and no widgets API.
    return `(function (data) {
      var send = function (action) {
        return function () { window.skyrimPlatform.sendMessage(data.key, action); };
      };
      if (!document.getElementById('hh-charselect-css')) {
        var css = document.createElement('style');
        css.id = 'hh-charselect-css';
        css.textContent =
          // Scoped, every one of them, because the style element outlives the
          // screen. Only the body class comes off on the way into the world, so
          // an unscoped rule here is a rule that applies to every window of the
          // session. Three of these were unscoped and did exactly that: every
          // button in the game became up to 24px with wrapping text, which is
          // most visible in the catalogs, where each row is a button. A page of
          // them grew tall enough that the frame stopped fitting the screen and
          // the scroll offset moved to a box the page reset was not looking at,
          // which brought back the page three bug it had already fixed once.
          'body.hh-charselect .button-middle {' +
          ' font-size: clamp(15px, 1.35vw, 24px) !important; }' +
          'body.hh-charselect .button-middle * { overflow: visible !important;' +
          ' text-overflow: clip !important; white-space: normal !important; }' +
          'body.hh-charselect .skymp-input-button_text {' +
          ' font-size: clamp(15px, 1.35vw, 24px) !important;' +
          ' overflow: visible !important; text-overflow: clip !important; }' +
          // Room to stand in. The window sizes itself to its contents
          // (constructor.js measures content_main and adds 96), so the way to
          // make it taller is to give the thing being measured a floor and a
          // margin under the last button, rather than to pin a height that the
          // confirmation rows would then overflow. Everything is border-box,
          // so the padding is inside the minimum.
          'body.hh-charselect .login-form--content_main {' +
          ' min-height: 600px !important; padding-bottom: 48px !important; }' +
          // Deleting is the secondary action on a row and should not be the
          // same size as the character it belongs to. The box comes from the
          // element itself, which the button honours; this is only the text.
          'body.hh-charselect .skymp-input-button_text {' +
          ' font-size: clamp(11px, 0.85vw, 15px) !important;' +
          ' line-height: 1.1 !important; }';
        document.head.appendChild(css);
      }
      document.body.classList.add('hh-charselect');
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
          if (!data.canDelete) {
            return;
          }
          if (window.hhConfirmDelete === slot.formId) {
            elements.push({ type: 'text', text: 'Delete ' + slot.name + ' forever?', tags: [] });
            elements.push({ type: 'button', text: 'Yes, delete ' + slot.name, tags: [],
              width: 216, height: 32,
              click: send('delete:' + slot.formId), hint: 'This cannot be undone' });
            elements.push({ type: 'button', text: 'Cancel', tags: [],
              width: 216, height: 32,
              click: function () { window.hhConfirmDelete = null; window.hhRenderPreSpawn(); },
              hint: 'Keep this character' });
          } else {
            elements.push({ type: 'button', text: 'Delete ' + slot.name, tags: [],
              width: 216, height: 32,
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
        window.hhWidgets.form = { type: 'form', id: 4, caption: 'Hearthheld', elements: elements };
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
        "document.body.classList.remove('hh-charselect');" +
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
