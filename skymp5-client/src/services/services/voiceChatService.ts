import { ClientListener, CombinedController, Sp } from "./clientListener";
import { BrowserMessageEvent, DxScanCode } from "skyrimPlatform";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { MsgType } from "../../messages";
import { logTrace, logError } from "../../logging";
import { RemoteServer } from "./remoteServer";
import { FormView } from "../../view/formView";
import { VOICE_RUNTIME_JS } from "./voiceRuntime";

const SIGNAL_EVENT_KEY = "voiceSignal";
const LOG_EVENT_KEY = "voiceLog";
/** Who the browser currently hears talking, so nametags can be tinted. */
const STATE_EVENT_KEY = "voiceState";

/**
 * Push to talk. Unbound in Skyrim's default controls, and deliberately not a
 * toggle: a toggle left switched on is how someone broadcasts a conversation
 * they thought was private.
 */
const PUSH_TO_TALK_KEY = DxScanCode.V;

/** How often the browser is told who is nearby. */
const PROXIMITY_INTERVAL_MS = 500;

/**
 * Anyone further away than this is not worth holding a peer connection open
 * for. The runtime fades voices out well before this; the radius only bounds
 * how many connections exist at once in a crowd.
 */
const CONNECT_RADIUS = 2500;

/**
 * A single transmission is never legitimately this long. Anything longer means
 * the key release was lost, so the microphone closes itself rather than staying
 * open silently.
 */
const MAX_TRANSMIT_MS = 60000;

interface VoicePeer {
  actorId: number;
  distance: number;
  name: string;
}

/**
 * Proximity voice chat.
 *
 * Three things live in three places, and this service is the middle one:
 *
 *   - Audio is WebRTC inside the CEF browser (see voiceRuntime.ts). Peer to
 *     peer; neither the game nor the server ever carries voice data.
 *   - Proximity is decided here, in the game process, because this is the only
 *     side that knows where anyone is standing.
 *   - Relaying the handshake is the server's job (the voiceSignal handler in
 *     gamemode.js), because a browser cannot address another player directly.
 *
 * Players are identified by actor FormID throughout, since that is the one
 * identifier a client can see about a nearby peer.
 */
export class VoiceChatService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("browserWindowLoaded", () => this.onBrowserWindowLoaded());
    this.controller.on("update", () => this.onUpdate());
  }

  private onBrowserWindowLoaded(): void {
    // Re-injecting is harmless: the runtime returns immediately if it is
    // already present. Doing it on every load matters because the front can
    // reload underneath us and take the runtime with it.
    try {
      this.sp.browser.executeJavaScript(VOICE_RUNTIME_JS);
      logTrace(this, `Voice runtime injected`);
    } catch (e) {
      logError(this, `Failed to inject the voice runtime`, e);
    }
  }

  private onUpdate(): void {
    this.updatePushToTalk();

    const now = Date.now();
    if (now - this.lastProximityPush < PROXIMITY_INTERVAL_MS) {
      return;
    }
    this.lastProximityPush = now;
    this.pushNearbyPeers();
  }

  private updatePushToTalk(): void {
    let down = false;
    try {
      down = this.sp.Input.isKeyPressed(PUSH_TO_TALK_KEY);
    } catch (e) {
      if (!this.keyReadFailed) {
        this.keyReadFailed = true;
        logError(this, `Cannot read the push to talk key`, e);
      }
      return;
    }

    if (down !== this.lastKeyState) {
      this.lastKeyState = down;
      logTrace(this, `[voice] push to talk key is ${down ? "down" : "up"}`);
    }

    // Last resort. If something still contrives to hold the key down, an open
    // microphone is the worst possible failure mode, so it closes itself.
    if (down && this.transmitting && Date.now() - this.transmitStartedAt > MAX_TRANSMIT_MS) {
      down = false;
    }

    if (down === this.transmitting) {
      return;
    }
    this.transmitting = down;
    if (down) {
      this.transmitStartedAt = Date.now();
    }
    try {
      this.sp.browser.executeJavaScript(
        `window.hhVoice && window.hhVoice.setTransmitting(${down ? "true" : "false"})`,
      );
    } catch (e) {
      logError(this, `Failed to set transmit state`, e);
    }
  }

  private pushNearbyPeers(): void {
    const peers = this.collectNearbyPeers();
    if (peers === undefined) {
      return;
    }
    // Nobody nearby now and nobody nearby last time. Skips a constant browser
    // round trip for someone standing alone.
    if (peers.list.length === 0 && this.lastPeerCount === 0) {
      return;
    }
    this.lastPeerCount = peers.list.length;
    try {
      this.sp.browser.executeJavaScript(
        `window.hhVoice && window.hhVoice.setPeers(${peers.selfActorId}, ${JSON.stringify(peers.list)})`,
      );
    } catch (e) {
      logError(this, `Failed to push voice peers`, e);
    }
  }

  /**
   * Everyone in the same cell and within range, with how far away they are.
   * Returns undefined when the world is not in a state worth reading yet,
   * which is a different thing from "nobody is nearby".
   */
  private collectNearbyPeers(): { selfActorId: number; list: VoicePeer[] } | undefined {
    let worldModel;
    try {
      worldModel = this.controller.lookupListener(RemoteServer).getWorldModel();
    } catch (e) {
      return undefined;
    }
    if (!worldModel || !worldModel.forms) {
      return undefined;
    }

    const self = worldModel.forms[worldModel.playerCharacterFormIdx];
    const selfActorId = worldModel.playerCharacterRefrId;
    if (!self || !selfActorId) {
      return undefined;
    }

    // The player's own transform is read from the game rather than from the
    // model, because the model only updates when a movement change is sent and
    // would otherwise lag a tick or two behind while walking.
    let sx: number, sy: number, sz: number;
    try {
      const player = this.sp.Game.getPlayer();
      if (!player) {
        return undefined;
      }
      sx = player.getPositionX();
      sy = player.getPositionY();
      sz = player.getPositionZ();
    } catch (e) {
      return undefined;
    }

    const selfCell = self.movement?.worldOrCell;
    const list: VoicePeer[] = [];

    for (const form of worldModel.forms) {
      if (!form || form.isMyClone) {
        continue;
      }
      const actorId = form.refrId;
      // Only server-owned actors are players. Anything below this range is a
      // record out of the game's own data, which cannot hold a microphone.
      if (typeof actorId !== "number" || actorId < 0xff000000 || actorId === selfActorId) {
        continue;
      }
      const movement = form.movement;
      if (!movement || !movement.pos) {
        continue;
      }
      // Voice does not carry between cells even when the coordinates happen to
      // be close, which they often are across different interiors.
      if (selfCell !== undefined && movement.worldOrCell !== selfCell) {
        continue;
      }
      const dx = movement.pos[0] - sx;
      const dy = movement.pos[1] - sy;
      const dz = movement.pos[2] - sz;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance > CONNECT_RADIUS) {
        continue;
      }
      list.push({
        actorId,
        distance: Math.round(distance),
        // The browser has no idea who anyone is, so the name travels with the
        // proximity update rather than being looked up over there.
        name: form.appearance?.name ?? "",
      });
    }

    return { selfActorId, list };
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    let content: Record<string, unknown>;
    try {
      content = JSON.parse(event.message.contentJsonDump);
    } catch (e) {
      return;
    }
    if (content["customPacketType"] !== "voiceSignal") {
      return;
    }

    const detail = JSON.stringify({
      fromActorId: content["fromActorId"],
      payload: content["payload"],
    });
    logTrace(this, `Delivering voice signal from actor`, content["fromActorId"]);
    this.sp.browser.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('hearthheld:voiceSignal', { detail: ${detail} }))`,
    );
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    // Diagnostics from inside the browser. WebRTC fails asynchronously and
    // silently, so without this a broken microphone or a rejected candidate
    // looks identical to nobody talking.
    if (e.arguments[0] === LOG_EVENT_KEY) {
      logTrace(this, `[voice] ${e.arguments[1]}`);
      return;
    }

    // Who is speaking is decided in the browser, which is where the audio
    // lives, but nametags are drawn by the game process.
    if (e.arguments[0] === STATE_EVENT_KEY) {
      try {
        const parsed = JSON.parse(`${e.arguments[1]}`) as { talking?: number[] };
        FormView.talkingRefrIds = new Set(parsed.talking ?? []);
      } catch (err) {
        logError(this, `Failed to parse voice state`, err);
      }
      return;
    }

    if (e.arguments[0] !== SIGNAL_EVENT_KEY) {
      return;
    }

    let outgoing: { targetActorId: number; payload: unknown };
    try {
      outgoing = JSON.parse(`${e.arguments[1]}`);
    } catch (err) {
      logError(this, `Failed to parse outgoing voice signal`, err);
      return;
    }

    const message: CustomPacketMessage = {
      t: MsgType.CustomPacket,
      contentJsonDump: JSON.stringify({
        customPacketType: "voiceSignal",
        targetActorId: outgoing.targetActorId,
        payload: outgoing.payload,
      }),
    };
    this.controller.emitter.emit("sendMessage", { message, reliability: "reliable" });
  }

  private keyReadFailed = false;
  private lastKeyState = false;
  private transmitStartedAt = 0;
  private lastProximityPush = 0;
  private lastPeerCount = 0;
  private transmitting = false;
}
