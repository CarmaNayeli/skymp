import { ClientListener, CombinedController, Sp } from "./clientListener";
import { BrowserMessageEvent } from "skyrimPlatform";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { MsgType } from "../../messages";
import { logTrace, logError } from "../../logging";

const BROWSER_EVENT_KEY = "voiceSignal";

/**
 * The transport for voice chat signaling only — SDP offers/answers and ICE
 * candidates. It does not touch audio at all; that's WebRTC running natively
 * inside the CEF-hosted React UI (skymp5-front), talking peer-to-peer once
 * connected. This service just carries the handshake data each direction:
 *
 *   React (RTCPeerConnection) --sendMessage--> here --CustomPacket--> server
 *     --CustomPacket--> peer's client --executeJavaScript--> peer's React
 *
 * The server-side half (relaying by actor FormID, since that's what a client
 * can see about a nearby peer) lives in gamemode.js, reusing the same
 * customPacket channel login already runs over — no new transport, no C++.
 */
export class VoiceChatService extends ClientListener {
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
    if (e.arguments[0] !== BROWSER_EVENT_KEY) {
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
}
