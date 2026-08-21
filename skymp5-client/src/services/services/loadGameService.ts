import { ClientListener, CombinedController, Sp } from "./clientListener";
import { logError, logTrace } from "../../logging";
import { ChangeFormNpc } from "skyrimPlatform";

export class LoadGameService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.controller.on("loadGame", () => this.onLoadGame());
    }

    public loadGame(pos: number[], rot: number[], worldOrCell: number, changeFormNpc?: ChangeFormNpc, loadOrder?: string[], time?: { seconds: number, minutes: number, hours: number }) {
        // Traced on both sides of the call, because this is where people have
        // been getting stuck and the log went quiet at exactly this point. A
        // line before and nothing after cannot distinguish loadGame throwing,
        // returning and the load never finishing, or the appearance retry below
        // being taken. Those want different fixes.
        logTrace(this, `loadGame: cell ${worldOrCell.toString(16)}, pos ${JSON.stringify(pos)},`,
            `${loadOrder ? loadOrder.length : 0} plugin(s), appearance ${changeFormNpc ? "yes" : "no"},`,
            `hour ${time ? time.hours : "none"}`);
        try {
            // @ts-ignore
            this.sp.loadGame(pos, rot, worldOrCell, changeFormNpc, loadOrder, time);
            logTrace(this, `loadGame returned`);
        } catch (e) {
            // Hotfix non-vanilla headparts bug
            logError(this, `loadGame threw, retrying without appearance:`, e);
            try {
                // @ts-ignore
                this.sp.loadGame(pos, rot, worldOrCell, undefined, loadOrder, time);
                logTrace(this, `loadGame returned on the retry`);
            } catch (e2) {
                // Previously this escaped and took the caller with it, so the
                // rest of spawning never ran and there was nothing in the log
                // to say why.
                logError(this, `loadGame threw on the retry as well:`, e2);
            }
        }
        this._isCausedBySkyrimPlatform = true;
    }

    private onLoadGame() {
        logTrace(this, `game finished loading, caused by us: ${this._isCausedBySkyrimPlatform}`);
        try {
            const gameLoadEvent = {
                isCausedBySkyrimPlatform: this._isCausedBySkyrimPlatform
            };
            this.controller.emitter.emit("gameLoad", gameLoadEvent);
        } catch (e) {
            this.controller.once("tick", () => {
                this._isCausedBySkyrimPlatform = false;
            });
            throw e;
        }
        this.controller.once("tick", () => {
            this._isCausedBySkyrimPlatform = false;
        });
    }

    private _isCausedBySkyrimPlatform = false;
}
