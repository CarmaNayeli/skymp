import { ClientListener, CombinedController, Sp } from "./clientListener";
import { logTrace, logError } from "../../logging";

/**
 * Puts an unmissable notice on screen whenever the connection to the server is
 * gone.
 *
 * Without this, losing the connection is invisible. The game carries on
 * rendering the world and you can still walk around in it, because movement is
 * simulated locally, so it looks exactly like playing. Nothing you do reaches
 * anyone, nothing is being saved, and the first clue is usually that other
 * players have stopped moving. A server restart, a dropped packet or a network
 * blip all present the same way.
 *
 * Drawn as a plain DOM element rather than a SkyrimPlatform widget, on purpose.
 * widgets.set replaces the entire widget list and is shared with chat, the
 * character screen and the menu, so a widget can be erased by any unrelated
 * screen. This has to survive whatever else happens to be drawn.
 */
export class DisconnectNoticeService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("connectionAccepted", () => this.onConnected());
    this.controller.emitter.on("connectionDisconnect", () => this.onLost("Lost connection to Hearthheld."));
    this.controller.emitter.on("connectionFailed", () => this.onLost("Cannot reach Hearthheld."));
    this.controller.emitter.on("connectionDenied", () => this.onLost("Hearthheld refused the connection."));
  }

  private onConnected(): void {
    if (!this.showing) {
      return;
    }
    this.showing = false;
    logTrace(this, `Connection restored, hiding the notice`);
    this.run(`window.hhDisconnect && window.hhDisconnect.hide()`);
  }

  private onLost(reason: string): void {
    // Repeated failures are normal while the client retries, and re-rendering
    // on each one makes the notice flicker.
    if (this.showing) {
      return;
    }
    this.showing = true;
    logTrace(this, `Connection lost, showing the notice: ${reason}`);
    this.ensureRuntime();
    this.run(`window.hhDisconnect && window.hhDisconnect.show(${JSON.stringify(reason)})`);
    // The overlay is useless behind a hidden browser, and something else may
    // have hidden it before the connection dropped.
    try {
      this.sp.browser.setVisible(true);
    } catch (e) {
      // Nothing to be done about it here.
    }
  }

  private ensureRuntime(): void {
    if (this.injected) {
      return;
    }
    this.injected = true;
    this.run(DISCONNECT_RUNTIME_JS);
  }

  private run(js: string): void {
    try {
      this.sp.browser.executeJavaScript(js);
    } catch (e) {
      logError(this, `Failed to update the disconnect notice`, e);
    }
  }

  private showing = false;
  private injected = false;
}

const DISCONNECT_RUNTIME_JS = `
(function () {
  if (window.hhDisconnect) { return; }

  var el = null;

  function build() {
    if (el || !document.body) { return; }
    el = document.createElement('div');
    el.id = 'hh-disconnected';
    el.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483640',
      'display:none', 'align-items:center', 'justify-content:center',
      // Dark enough that the world behind is clearly not something you are
      // still part of, but not so dark that you cannot see where you were.
      'background:rgba(6,8,10,0.82)',
      'font-family:Segoe UI,Arial,sans-serif', 'color:#f2e9d8',
      'text-align:center', 'pointer-events:none'
    ].join(';');
    document.body.appendChild(el);
  }

  window.hhDisconnect = {
    show: function (reason) {
      build();
      if (!el) { return; }
      el.innerHTML =
        '<div>' +
        '<div style="font-size:30px;letter-spacing:1px;margin-bottom:14px">' +
          'Disconnected' +
        '</div>' +
        '<div style="font-size:15px;opacity:0.85;margin-bottom:10px">' +
          String(reason || 'Lost connection to Hearthheld.') +
        '</div>' +
        '<div style="font-size:14px;opacity:0.7">' +
          'Trying to reconnect. Anything you do now will not be saved.' +
        '</div>' +
        '<div style="font-size:13px;opacity:0.55;margin-top:16px">' +
          'If this stays up, quit to the main menu and rejoin.' +
        '</div>' +
        '</div>';
      el.style.display = 'flex';
    },
    hide: function () {
      if (el) { el.style.display = 'none'; }
    }
  };
})();
`;
